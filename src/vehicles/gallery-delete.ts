import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../shared/errors'
import { deleteCloudflareImage } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const vehicleId    = Number(event.pathParameters?.id)
  const galleryRowId = Number(event.pathParameters?.imageId)

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[row]] = await db.query<any[]>(
      'SELECT id, image_id FROM vehicle_gallery_images WHERE id = ? AND vehicle_id = ? AND deleted_at IS NULL LIMIT 1',
      [galleryRowId, vehicleId],
    )
    if (!row) return notFound('Image')

    // Soft-delete DB row first — hard delete from Cloudflare regardless of
    // outcome. Cloudflare failure is logged but not surfaced (image is
    // already invisible to callers via the deleted_at guard).
    await db.query(
      'UPDATE vehicle_gallery_images SET deleted_at = NOW() WHERE id = ?',
      [row.id],
    )

    await deleteCloudflareImage(row.image_id).catch(err =>
      console.error(`Failed to delete Cloudflare image ${row.image_id}:`, err),
    )

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
