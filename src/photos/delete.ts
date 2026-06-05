import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../shared/errors'
import { deleteCloudflareImage } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const [[photo]] = await db.query<any[]>(
      'SELECT id, image_id, uploaded_by FROM photos WHERE id = ? LIMIT 1',
      [id],
    )
    if (!photo) return notFound('Photo')

    const isOwner   = String(photo.uploaded_by) === String(ctx.staffId)
    const isManager = ctx.role === 'store_manager'
    const isAdmin   = ctx.role === 'super_admin'

    if (!isOwner && !isManager && !isAdmin) return forbidden()

    try {
      await deleteCloudflareImage(photo.image_id)
    } catch (err) {
      console.error('Cloudflare image delete failed:', err)
    }

    await db.query('DELETE FROM photos WHERE id = ?', [id])

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
