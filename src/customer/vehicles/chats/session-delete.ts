import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { archiveSessionBlob } from './messagesStore'

const ready = bootstrap()

// Soft delete. Moves the S3 blob from diagnostic-sessions/current/ →
// diagnostic-sessions/archived/, marks the metadata row with deleted_at.
// Attached Cloudflare images are LEFT intact so the archived record is
// complete and restorable — cleanup can happen via a separate purge job
// later if we ever add "delete permanently".
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    await archiveSessionBlob(sessionId)
    await db.query(
      'UPDATE customer_chat_sessions SET deleted_at = NOW() WHERE id = ?',
      [sessionId],
    )

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
