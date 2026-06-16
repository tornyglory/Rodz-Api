import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, serverError } from '../../shared/errors'
import { buildApiUser, toDbRole, userError, ADMIN_ROLES, VALID_ROLES, STAFF_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const { firstName, lastName, email, mobile, password, role, storeId, status } = JSON.parse(event.body ?? '{}')

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !role || !password?.trim()) {
      return userError(422, 'VALIDATION_ERROR', 'firstName, lastName, email, role, and password are required.')
    }
    if (!VALID_ROLES.includes(role)) {
      return userError(422, 'VALIDATION_ERROR', 'Invalid role value.')
    }

    // store_manager cannot create admin roles or staff outside their own store
    if (ctx.role === 'store_manager') {
      if (ADMIN_ROLES.has(role)) return forbidden()
      if (storeId != null && Number(storeId) !== Number(ctx.storeId)) return forbidden()
    }

    const targetStoreId = ctx.role === 'store_manager' ? ctx.storeId : (storeId ?? ctx.storeId)

    // Validate store exists
    const [[storeRow]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE id = ? LIMIT 1',
      [targetStoreId],
    )
    if (!storeRow) return userError(422, 'VALIDATION_ERROR', 'Store not found.')

    // Email uniqueness
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM staff WHERE email = ? LIMIT 1',
      [email.trim().toLowerCase()],
    )
    if (existing) return userError(409, 'EMAIL_TAKEN', 'A user with that email already exists.')

    const dbRole   = toDbRole(role)
    const isActive = status === 'inactive' ? 0 : 1
    const hash     = await bcrypt.hash(password, 12)

    const [result] = await db.query<any>(
      `INSERT INTO staff (store_id, first_name, last_name, email, mobile, role, is_active, hired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
      [targetStoreId, firstName.trim(), lastName.trim(), email.trim().toLowerCase(), mobile?.trim() ?? null, dbRole, isActive],
    )

    await db.query(
      `INSERT INTO staff_auth (staff_id, password_hash, failed_login_attempts)
       VALUES (?, ?, 0)`,
      [result.insertId, hash],
    )

    const [[row]] = await db.query<any[]>(
      `${STAFF_SELECT} WHERE s.id = ? LIMIT 1`,
      [result.insertId],
    )
    return created({ user: buildApiUser(row) })
  } catch (err) {
    return serverError(err)
  }
}
