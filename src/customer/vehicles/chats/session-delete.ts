import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'

const ready = bootstrap()

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

    const [images] = await db.query<any[]>(
      'SELECT image_id FROM customer_vehicle_chats WHERE session_id = ? AND image_id IS NOT NULL',
      [sessionId],
    )

    await db.query('DELETE FROM customer_vehicle_chats WHERE session_id = ?', [sessionId])
    await db.query('DELETE FROM customer_chat_sessions WHERE id = ?', [sessionId])

    await Promise.allSettled(images.map((r: any) => deleteCloudflareImage(r.image_id)))

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
