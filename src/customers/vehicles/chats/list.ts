import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, notFound, serverError } from '../../../shared/errors'
import { imageUrls } from '../../../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

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

    const [rows] = await db.query<any[]>(
      `SELECT
         vc.id,
         vc.started_by_staff_id AS staff_id,
         vc.created_at,
         st.first_name,
         st.last_name,
         st.avatar_image_id,
         (SELECT COUNT(*) FROM vehicle_chat_messages vcm WHERE vcm.chat_id = vc.id) AS message_count,
         (SELECT vcm2.content
          FROM vehicle_chat_messages vcm2
          WHERE vcm2.chat_id = vc.id
          ORDER BY vcm2.id ASC
          LIMIT 1) AS first_message
       FROM vehicle_chats vc
       JOIN staff st ON st.id = vc.started_by_staff_id
       WHERE vc.vehicle_id = ?
       ORDER BY vc.created_at DESC`,
      [vehicleId],
    )

    const chats = rows.map((r: any) => ({
      id:           r.id,
      createdAt:    new Date(r.created_at).toISOString(),
      staffId:      r.staff_id,
      mechanic:     `${r.first_name} ${r.last_name}`,
      avatar:       r.avatar_image_id ? imageUrls(r.avatar_image_id) : null,
      messageCount: r.message_count,
      preview:      r.first_message ?? null,
    }))

    return ok({ chats })
  } catch (err) {
    return serverError(err)
  }
}
