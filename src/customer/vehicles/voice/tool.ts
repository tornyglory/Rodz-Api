import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, getCustomerTier } from '../../_helpers'
import { runBookingTool } from '../chats/_tools'

const ready = bootstrap()

const VOICE_MODE_ENABLED = process.env.VOICE_MODE_ENABLED === 'true'

const ALLOWED_TOOLS = new Set([
  'checkAvailability', 'checkTimeSlots', 'checkCourtesyCars',
  'getVehicleValue', 'getServiceTypes', 'bookAppointment',
])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (!VOICE_MODE_ENABLED) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DISABLED', message: 'Voice mode is disabled.' }) }
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

    const body       = JSON.parse(event.body ?? '{}')
    const sessionId  = Number(body.sessionId)
    const toolCallId = body.toolCallId ? String(body.toolCallId) : null
    const name       = body.name ? String(body.name) : ''
    const args       = body.args ?? {}

    if (!sessionId)  return validationError('sessionId is required')
    if (!toolCallId) return validationError('toolCallId is required')
    if (!name)       return validationError('name is required')

    if (!ALLOWED_TOOLS.has(name)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'UNKNOWN_TOOL', message: `Tool "${name}" is not permitted in voice mode.` }),
      }
    }

    // Defence-in-depth: the tool call must be attached to a session the
    // customer actually owns. Prevents a compromised browser from executing
    // tools against another session/vehicle.
    const [[owned]] = await db.query<any[]>(
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!owned) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'FORBIDDEN_SESSION', message: 'Session does not belong to this customer.' }),
      }
    }

    const result = await runBookingTool(
      db,
      { customerId: ctx.customerId, vehicleId },
      name,
      args,
    )

    return ok({ toolCallId, result })
  } catch (err) {
    return serverError(err)
  }
}
