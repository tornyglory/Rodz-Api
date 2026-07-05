import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         s.updated_at,
         (SELECT content FROM customer_vehicle_chats
          WHERE session_id = s.id ORDER BY id DESC LIMIT 1) AS last_content,
         (SELECT created_at FROM customer_vehicle_chats
          WHERE session_id = s.id ORDER BY id DESC LIMIT 1) AS last_message_at
       FROM customer_chat_sessions s
       WHERE s.vehicle_id = ? AND s.customer_id = ?
       ORDER BY s.updated_at DESC
       LIMIT 50`,
      [vehicleId, ctx.customerId],
    )

    const sessions = rows.map((r: any) => ({
      id:            r.id,
      title:         r.title ?? null,
      preview:       r.last_content ? String(r.last_content).slice(0, 120) : null,
      lastMessageAt: r.last_message_at instanceof Date
        ? r.last_message_at.toISOString()
        : r.last_message_at ? String(r.last_message_at) : null,
      createdAt: r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    }))

    return ok({ sessions })
  } catch (err) {
    return serverError(err)
  }
}
