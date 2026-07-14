import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, getCustomerTier } from '../../_helpers'

const ready = bootstrap()

const VOICE_MODE_ENABLED = process.env.VOICE_MODE_ENABLED === 'true'
const VALID_REASONS = new Set(['user_hangup', 'timeout', 'error', 'interrupted'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (!VOICE_MODE_ENABLED) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DISABLED' }) }
  }

  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const tier = await getCustomerTier(db, ctx.customerId)
    if (tier !== 'gold') return forbidden()

    const body        = JSON.parse(event.body ?? '{}')
    const sessionId   = Number(body.sessionId)
    const seconds     = Math.max(0, Math.min(Number(body.seconds) || 0, 3600))
    const endedReason = String(body.endedReason ?? '')

    if (!sessionId)                     return validationError('sessionId is required')
    if (!VALID_REASONS.has(endedReason)) return validationError('endedReason must be one of user_hangup, timeout, error, interrupted')

    // Session ownership check
    const [[owned]] = await db.query<any[]>(
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!owned) return forbidden()

    await db.query(
      `INSERT INTO customer_voice_usage (customer_id, session_id, seconds, ended_reason)
       VALUES (?, ?, ?, ?)`,
      [ctx.customerId, sessionId, seconds, endedReason],
    )

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
