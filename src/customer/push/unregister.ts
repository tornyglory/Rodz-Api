import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// DELETE /c/push/register — called on customer sign-out. Removes the token
// so we don't keep pushing to a device that just logged out.
//
// Constrained by customer_id so a compromised token can't wipe another
// customer's registrations. If the token belongs to a different customer
// we silently no-op (still returns 200 — the client shouldn't leak that).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) return validationError('token is required.')

    await db.query(
      'DELETE FROM customer_push_tokens WHERE token = ? AND customer_id = ?',
      [token, ctx.customerId],
    )

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
