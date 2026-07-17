import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, notFound, gone, validationError, serverError } from '../shared/errors'
import { verifyImage, imageUrls } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[vRow]] = await db.query<any[]>(
      'SELECT id, is_active FROM vehicles WHERE id = ? LIMIT 1',
      [vehicleId],
    )
    if (!vRow)          return notFound('Vehicle')
    if (!vRow.is_active) return gone('Vehicle')

    const { imageId } = JSON.parse(event.body ?? '{}')
    if (!imageId || typeof imageId !== 'string') return validationError('imageId is required.')

    const exists = await verifyImage(imageId)
    if (!exists) return validationError('Image not found on Cloudflare — upload may not have completed.')

    const [[{ maxOrder }]] = await db.query<any[]>(
      'SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM vehicle_gallery_images WHERE vehicle_id = ? AND deleted_at IS NULL',
      [vehicleId],
    )
    const sortOrder = Number(maxOrder) + 1

    const [result] = await db.query<any>(
      'INSERT INTO vehicle_gallery_images (vehicle_id, image_id, sort_order) VALUES (?, ?, ?)',
      [vehicleId, imageId, sortOrder],
    )

    const urls = imageUrls(imageId)
    return created({
      image: {
        id:           result.insertId,
        url:          urls.public,
        thumbnailUrl: urls.thumbnail,
        sortOrder,
      },
    })
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return validationError('This image has already been added to the gallery.')
    }
    return serverError(err)
  }
}
