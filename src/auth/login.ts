import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import * as jwt from 'jsonwebtoken'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import {
  ok, validationError, invalidCredentials, accountDisabled,
  accountLocked, serverError,
} from '../shared/errors'
import {
  toSystemRole, isTechRole, resolveStores, resolvePermissions,
  resolveHomeStoreName, buildUserObject,
} from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    // Validate input
    const body = JSON.parse(event.body ?? '{}') as { email?: string; password?: string }
    if (!body.email?.trim() || !body.password?.trim()) {
      return validationError('email and password are required.')
    }

    const db = getPool()

    // Look up staff + auth record in one query
    const [rows] = await db.query<any[]>(
      `SELECT
         s.id, s.first_name, s.last_name, s.email, s.mobile,
         s.role, s.colour_code, s.store_id, s.is_active,
         sa.password_hash, sa.failed_login_attempts, sa.locked_until, sa.force_reset
       FROM staff s
       JOIN staff_auth sa ON sa.staff_id = s.id
       WHERE s.email = ?`,
      [body.email.trim()],
    )

    const staff = rows[0]
    if (!staff) return invalidCredentials()

    if (!staff.is_active) return accountDisabled()

    // Check lockout
    if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
      return accountLocked(new Date(staff.locked_until))
    }

    // Verify password
    const valid = await bcrypt.compare(body.password, staff.password_hash)

    if (!valid) {
      await db.query(
        `UPDATE staff_auth
         SET
           failed_login_attempts = CASE
             WHEN failed_login_attempts + 1 >= 5 THEN 0
             ELSE failed_login_attempts + 1
           END,
           locked_until = CASE
             WHEN failed_login_attempts + 1 >= 5 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE)
             ELSE NULL
           END
         WHERE staff_id = ?`,
        [staff.id],
      )
      return invalidCredentials()
    }

    // Reset failed attempts
    await db.query(
      'UPDATE staff_auth SET failed_login_attempts = 0, locked_until = NULL WHERE staff_id = ?',
      [staff.id],
    )

    // Resolve stores, permissions, home store name in parallel
    const [stores, permissions, homeStoreName] = await Promise.all([
      resolveStores(db, staff.id, staff.store_id),
      resolvePermissions(db, staff.id, staff.role),
      resolveHomeStoreName(db, staff.store_id),
    ])

    // Build JWT payload
    const payload: Record<string, unknown> = {
      sub:         String(staff.id),
      role:        toSystemRole(staff.role),
      store:       homeStoreName,
      storeId:     staff.store_id,
      permissions,
      exp:         Math.floor(Date.now() / 1000) + (8 * 60 * 60),
    }
    if (isTechRole(staff.role)) payload.techId = staff.id

    const accessToken = jwt.sign(payload, process.env.JWT_SECRET!)

    // Persist session
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')
    const ip        = event.requestContext.http.sourceIp
    const userAgent = event.headers['user-agent'] ?? event.headers['User-Agent'] ?? 'unknown'

    await db.query(
      `INSERT INTO staff_sessions (staff_id, token_hash, device_type, ip_address, user_agent, expires_at)
       VALUES (?, ?, 'web', ?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR))`,
      [staff.id, tokenHash, ip, userAgent],
    )

    return ok({ accessToken, user: buildUserObject(staff, homeStoreName, stores, permissions) })
  } catch (err) {
    return serverError(err)
  }
}
