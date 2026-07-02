import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import * as jwt from 'jsonwebtoken'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import {
  ok, validationError, invalidCredentials, accountLocked, serverError,
} from '../../shared/errors'
import { buildCustomer, buildVehicleSummary } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    const body = JSON.parse(event.body ?? '{}') as { email?: string; password?: string }
    if (!body.email?.trim() || !body.password?.trim()) {
      return validationError('email and password are required.')
    }

    const db = getPool()
    const emailStr = body.email.trim().toLowerCase()

    const [[row]] = await db.query<any[]>(
      `SELECT
         c.id, c.first_name, c.last_name, c.email, c.mobile,
         c.suburb, c.state, c.postcode, c.date_of_birth,
         c.marketing_opt_in, c.sms_opt_in, c.avatar_image_id, c.created_at, c.is_active,
         ca.password_hash, ca.failed_login_attempts, ca.locked_until
       FROM customers c
       JOIN customer_auth ca ON ca.customer_id = c.id
       WHERE c.email = ? LIMIT 1`,
      [emailStr],
    )

    if (!row || !row.is_active) return invalidCredentials()

    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      return accountLocked(new Date(row.locked_until))
    }

    const valid = await bcrypt.compare(body.password!, row.password_hash)

    if (!valid) {
      await db.query(
        `UPDATE customer_auth SET
           failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= 5 THEN 0 ELSE failed_login_attempts + 1 END,
           locked_until          = CASE WHEN failed_login_attempts + 1 >= 5 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE) ELSE NULL END
         WHERE customer_id = ?`,
        [row.id],
      )
      return invalidCredentials()
    }

    await db.query(
      'UPDATE customer_auth SET failed_login_attempts = 0, locked_until = NULL WHERE customer_id = ?',
      [row.id],
    )

    const exp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    const accessToken = jwt.sign({ sub: String(row.id), type: 'customer', exp }, process.env.JWT_SECRET!)

    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')
    const ip        = event.requestContext.http.sourceIp
    const userAgent = event.headers['user-agent'] ?? event.headers['User-Agent'] ?? 'unknown'

    await db.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, ip_address, user_agent, expires_at, created_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
      [row.id, tokenHash, ip, userAgent],
    )

    const [vehicleRows] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.make, v.model, v.year, v.avatar_image_id, v.cover_image_id, v.logbook_token
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1`,
      [row.id],
    )

    const customer = buildCustomer(row, vehicleRows.map(buildVehicleSummary))

    return ok({ accessToken, customer })
  } catch (err) {
    return serverError(err)
  }
}
