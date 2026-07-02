import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, serverError } from '../../shared/errors'
import { imageUrls } from '../../shared/cloudflare'
import { getCustomerContext } from '../_helpers'

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
      `SELECT id, role, content, image_id, created_at
       FROM customer_vehicle_chats
       WHERE vehicle_id = ? AND customer_id = ?
       ORDER BY id ASC
       LIMIT 100`,
      [vehicleId, ctx.customerId],
    )

    const messages = rows.map((r: any) => ({
      id:        r.id,
      role:      r.role,
      content:   r.content    ?? null,
      imageUrl:  r.image_id   ? imageUrls(r.image_id).public : null,
      createdAt: r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    }))

    return ok({ messages })
  } catch (err) {
    return serverError(err)
  }
}
