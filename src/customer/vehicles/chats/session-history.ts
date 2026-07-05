import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'

const ready = bootstrap()
const PAGE_SIZE = 50

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)
  const before    = event.queryStringParameters?.before ? Number(event.queryStringParameters.before) : null

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      'SELECT id, title FROM customer_chat_sessions WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    const [rows] = before
      ? await db.query<any[]>(
          `SELECT id, role, content, image_id, created_at
           FROM customer_vehicle_chats
           WHERE session_id = ? AND id < ?
           ORDER BY id DESC LIMIT ?`,
          [sessionId, before, PAGE_SIZE + 1],
        )
      : await db.query<any[]>(
          `SELECT id, role, content, image_id, created_at
           FROM customer_vehicle_chats
           WHERE session_id = ?
           ORDER BY id DESC LIMIT ?`,
          [sessionId, PAGE_SIZE + 1],
        )

    const hasMore = rows.length > PAGE_SIZE
    if (hasMore) rows.pop()
    rows.reverse()

    const messages = rows.map((r: any) => ({
      id:        r.id,
      role:      r.role,
      content:   r.content  ?? null,
      imageUrl:  r.image_id ? imageUrls(r.image_id).public : null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }))

    return ok({
      sessionId,
      title:          session.title ?? null,
      messages,
      hasMore,
      oldestMessageId: messages[0]?.id ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
