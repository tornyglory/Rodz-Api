import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'

const ready = bootstrap()

// POST /customers/{id}/unlock
//
// Staff-side rescue for a customer who's hit the 5-strike lockout on
// their app. Clears `failed_login_attempts` + `locked_until` so they can
// try again immediately with their existing password. Does NOT rotate
// the password — most lockouts are fat-finger, not forgotten passwords.
//
// Logs to customer_auth_log so we know who unlocked whom.
//
// Role guard: technicians blocked. Store managers + super admins allowed
// against any customer — customers aren't scoped to a single store, and
// the workshop-side unlock is a support action.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = Number(event.pathParameters?.id)

  if (ctx.role === 'technician') return forbidden()
  if (!id) return validationError('customer id is required.')

  try {
    // Verify the customer exists — cleaner error than a silent UPDATE.
    const [[cust]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? LIMIT 1',
      [id],
    )
    if (!cust) return notFound('Customer')

    // Idempotent: clears the counter + lockout even if already clear.
    const [result] = await db.query<any>(
      `UPDATE customer_auth
       SET failed_login_attempts = 0, locked_until = NULL
       WHERE customer_id = ?`,
      [id],
    )

    // No customer_auth row = customer has never set a password (magic-link
    // signup, oauth, etc). Nothing to unlock, but the customer exists —
    // return ok so the UI stays quiet.
    if (result.affectedRows === 0) {
      return ok({ id, unlocked: false, reason: 'no_auth_row' })
    }

    // Audit trail — non-fatal if the insert fails, the unlock still stands.
    try {
      await db.query(
        `INSERT INTO customer_auth_log (customer_id, event_type, ip_address, user_agent, metadata)
         VALUES (?, 'account_unlocked', ?, ?, ?)`,
        [
          id,
          event.requestContext.http.sourceIp ?? null,
          event.headers['user-agent'] ?? event.headers['User-Agent'] ?? null,
          JSON.stringify({ unlocked_by_staff_id: ctx.staffId, role: ctx.role }),
        ],
      )
    } catch (err) {
      console.warn('[unlock] failed to write customer_auth_log (non-fatal):', err)
    }

    return ok({ id, unlocked: true })
  } catch (err) {
    return serverError(err)
  }
}
