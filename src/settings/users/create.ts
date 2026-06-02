import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { buildApiUser, toDbRole, splitFullName } from './_helpers'

const ready = bootstrap()

const VALID_ROLES = new Set([
  'super_admin', 'store_manager',
  'senior_mechanic', 'qualified_mechanic', 'service_tech',
  'tyre_tech', 'receptionist', 'apprentice', 'technician',
])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const { fullName, email, role, store, status, password } = JSON.parse(event.body ?? '{}')

    if (!fullName?.trim() || !email?.trim() || !role || !password?.trim()) {
      return validationError('fullName, email, role, and password are required.')
    }
    if (!VALID_ROLES.has(role)) {
      return validationError('Invalid role value.')
    }
    if (role !== 'super_admin' && !store?.trim()) {
      return validationError('store is required for store_manager and technician roles.')
    }

    const [existing] = await db.query<any[]>(
      'SELECT id FROM staff WHERE email = ? LIMIT 1',
      [email.trim().toLowerCase()],
    )
    if (existing.length > 0) return validationError('A user with that email already exists.')

    let storeId: number
    if (role === 'super_admin') {
      storeId = Number(ctx.storeId)
    } else {
      const [storeRows] = await db.query<any[]>(
        'SELECT id FROM stores WHERE name = ? LIMIT 1',
        [store.trim()],
      )
      if (storeRows.length === 0) return validationError(`Store "${store}" not found.`)
      storeId = storeRows[0].id
    }

    const { first_name, last_name } = splitFullName(fullName.trim())
    const dbRole    = toDbRole(role)
    const isActive  = status === 'inactive' ? 0 : 1
    const hash      = await bcrypt.hash(password, 12)

    const [result] = await db.query<any>(
      `INSERT INTO staff (first_name, last_name, email, role, store_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [first_name, last_name, email.trim().toLowerCase(), dbRole, storeId, isActive],
    )

    await db.query(
      `INSERT INTO staff_auth (staff_id, password_hash, failed_login_attempts)
       VALUES (?, ?, 0)`,
      [result.insertId, hash],
    )

    const [rows] = await db.query<any[]>(
      `SELECT s.id, s.first_name, s.last_name, s.email, s.role, s.is_active, s.created_at,
              st.name AS store_name
       FROM staff s
       JOIN stores st ON st.id = s.store_id
       WHERE s.id = ? LIMIT 1`,
      [result.insertId],
    )
    return created({ user: buildApiUser(rows[0]) })
  } catch (err) {
    return serverError(err)
  }
}
