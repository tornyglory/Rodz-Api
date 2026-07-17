import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, gone, serverError } from '../shared/errors'
import { imageUrls } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  getAuthContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[vRow]] = await db.query<any[]>(
      'SELECT id, is_active FROM vehicles WHERE id = ? LIMIT 1',
      [vehicleId],
    )
    if (!vRow)          return notFound('Vehicle')
    if (!vRow.is_active) return gone('Vehicle')

    const [rows] = await db.query<any[]>(
      `SELECT id, image_id, sort_order
         FROM vehicle_gallery_images
        WHERE vehicle_id = ? AND deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC`,
      [vehicleId],
    )

    return ok({
      gallery: rows.map(r => ({
        id:           r.id,
        url:          imageUrls(r.image_id).public,
        thumbnailUrl: imageUrls(r.image_id).thumbnail,
        sortOrder:    r.sort_order,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
