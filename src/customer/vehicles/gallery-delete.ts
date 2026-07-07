import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { noContent, forbidden, notFound, serverError } from '../../shared/errors'
import { deleteCloudflareImage } from '../../shared/cloudflare'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const imageId   = event.pathParameters?.imageId

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[row]] = await db.query<any[]>(
      'SELECT id, image_id FROM vehicle_gallery_images WHERE vehicle_id = ? AND image_id = ? AND deleted_at IS NULL LIMIT 1',
      [vehicleId, imageId],
    )
    if (!row) return notFound('Image')

    // Soft-delete DB row first — delete from Cloudflare regardless of result
    await db.query(
      'UPDATE vehicle_gallery_images SET deleted_at = NOW() WHERE id = ?',
      [row.id],
    )

    await deleteCloudflareImage(row.image_id).catch(() => {})

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
