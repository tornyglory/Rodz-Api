import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { getDirectUploadUrl, verifyImage, imageUrls } from '../../shared/cloudflare'
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
