import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// POST /c/push/register — idempotent device-token registration.
//
// Semantics (from rodz-staff/docs/endpoints/push-notifications-customer.md):
//   - (customer_id, token) already exists → no-op success.
//   - Same token seen for a different customer → overwrite (shared device
//     with a new account signed in). Never duplicate.
//   - Every call bumps last_seen_at so we can surface "Signed-in devices"
//     in Settings and prune stale rows later.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const token    = typeof body.token    === 'string' ? body.token.trim()    : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const label    = typeof body.label    === 'string' ? body.label.trim().slice(0, 200) : null

    if (!token) return validationError('token is required.')
    if (platform !== 'ios' && platform !== 'android') {
      return validationError("platform must be 'ios' or 'android'.")
    }
    if (token.length > 512) return validationError('token exceeds 512 characters.')

    // UPSERT keyed on the unique `token` column. If the token exists for
    // any customer it gets reassigned to this caller; last_seen_at bumps.
    await db.query(
      `INSERT INTO customer_push_tokens (customer_id, token, platform, label)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         customer_id  = VALUES(customer_id),
         platform     = VALUES(platform),
         label        = COALESCE(VALUES(label), label),
         last_seen_at = CURRENT_TIMESTAMP`,
      [ctx.customerId, token, platform, label],
    )

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
