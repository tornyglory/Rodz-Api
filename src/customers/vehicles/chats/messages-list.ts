import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, notFound, serverError } from '../../../shared/errors'
import { imageUrls } from '../../../shared/cloudflare'

const ready = bootstrap()
const PAGE_SIZE = 50

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId, chatId } = event.pathParameters ?? {}
  const qs = event.queryStringParameters ?? {}

  // before=<messageId> — return the PAGE_SIZE messages older than that ID (scroll-up pagination)
  const before = qs.before ? Number(qs.before) : null

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicle) return notFound('Vehicle')

    if (ctx.role !== 'super_admin') {
      const [[customer]] = await db.query<any[]>(
        'SELECT store_id FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customer?.store_id !== ctx.storeId) return notFound('Vehicle')
    }

    const [[chat]] = await db.query<any[]>(
      'SELECT id FROM vehicle_chats WHERE id = ? AND vehicle_id = ? LIMIT 1',
      [chatId, vehicleId],
    )
    if (!chat) return notFound('Chat')

    // Fetch one extra row so we can tell whether there are more pages
    const limit = PAGE_SIZE + 1
    const [rows] = before
      ? await db.query<any[]>(
          `SELECT vcm.id, vcm.role, vcm.content, vcm.image_id, vcm.staff_id, vcm.created_at,
                  st.first_name, st.last_name
           FROM vehicle_chat_messages vcm
           LEFT JOIN staff st ON st.id = vcm.staff_id
           WHERE vcm.chat_id = ? AND vcm.id < ?
           ORDER BY vcm.id DESC
           LIMIT ?`,
          [chatId, before, limit],
        )
      : await db.query<any[]>(
          `SELECT vcm.id, vcm.role, vcm.content, vcm.image_id, vcm.staff_id, vcm.created_at,
                  st.first_name, st.last_name
           FROM vehicle_chat_messages vcm
           LEFT JOIN staff st ON st.id = vcm.staff_id
           WHERE vcm.chat_id = ?
           ORDER BY vcm.id DESC
           LIMIT ?`,
          [chatId, limit],
        )

    const hasMore = rows.length > PAGE_SIZE
    if (hasMore) rows.pop()

    // Reverse so messages are returned oldest-first for the UI to render top-to-bottom
    rows.reverse()

    const messages = rows.map((r: any) => ({
      id:        r.id,
      role:      r.role,
      content:   r.content  ?? null,
      image:     r.image_id ? imageUrls(r.image_id) : null,
      sentBy:    r.first_name ? `${r.first_name} ${r.last_name}` : null,
      staffId:   r.staff_id ?? null,
      createdAt: new Date(r.created_at).toISOString(),
    }))

    return ok({
      messages,
      hasMore,
      // Pass this as `before` on the next request to get the next page of older messages
      oldestMessageId: messages.length > 0 ? messages[0].id : null,
    })
  } catch (err) {
    return serverError(err)
  }
}
