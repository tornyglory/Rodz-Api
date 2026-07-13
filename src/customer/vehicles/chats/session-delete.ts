import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'
import { loadSession, deleteSessionBlob } from './messagesStore'

const ready = bootstrap()

// Deletes the S3 session blob and the customer_chat_sessions metadata row.
// Also fires off any Cloudflare image deletions for images referenced in the
// session.
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
      'SELECT id FROM customer_chat_sessions WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    // Pull image ids from the blob before wiping it, so we can clean up
    // Cloudflare Images too. Non-fatal if any of this fails.
    const { blob } = await loadSession(sessionId)
    const imageIds = (blob?.messages ?? [])
      .map(m => m.imageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    await deleteSessionBlob(sessionId)
    await db.query('DELETE FROM customer_chat_sessions WHERE id = ?', [sessionId])

    await Promise.allSettled(imageIds.map(id => deleteCloudflareImage(id)))

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
