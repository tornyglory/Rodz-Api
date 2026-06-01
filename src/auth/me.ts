import * as crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, sessionExpired, accountDisabled, serverError } from '../shared/errors'
import { resolveStores, resolvePermissions, resolveHomeStoreName, buildUserObject } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { staffId } = getAuthContext(event)

  try {
    // Verify session has not been revoked
    const rawToken  = (event.headers.authorization ?? event.headers.Authorization ?? '').replace(/^Bearer /i, '')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

    const [sessionRows] = await db.query<any[]>(
      'SELECT id FROM staff_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()',
      [tokenHash],
    )
    if (!sessionRows[0]) return sessionExpired()

    // Fetch fresh staff record — do not trust cached JWT claims for user-facing fields
    const [staffRows] = await db.query<any[]>(
      'SELECT id, first_name, last_name, email, role, store_id, is_active FROM staff WHERE id = ? LIMIT 1',
      [staffId],
    )
    const staff = staffRows[0]
    if (!staff || !staff.is_active) return accountDisabled()

    // Resolve stores, permissions, home store name in parallel
    const [stores, permissions, homeStoreName] = await Promise.all([
      resolveStores(db, staff.id, staff.store_id, staff.role),
      resolvePermissions(db, staff.id, staff.role),
      resolveHomeStoreName(db, staff.store_id),
    ])

    return ok({ user: buildUserObject(staff, homeStoreName, stores, permissions) })
  } catch (err) {
    return serverError(err)
  }
}
