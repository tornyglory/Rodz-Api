import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, gone, serverError } from '../shared/errors'
import { getDirectUploadUrl } from '../shared/cloudflare'

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

    const { uploadUrl, imageId } = await getDirectUploadUrl(
      `vehicle-gallery-${vehicleId}`,
      {
        type:       'vehicle_gallery',
        vehicleId:  String(vehicleId),
        uploadedBy: `staff:${ctx.staffId}`,
      },
    )
    return ok({ uploadUrl, imageId })
  } catch (err) {
    console.error('Cloudflare direct upload URL error:', err)
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'CLOUDFLARE_ERROR', message: 'Failed to generate upload URL.' } }),
    }
  }
}
