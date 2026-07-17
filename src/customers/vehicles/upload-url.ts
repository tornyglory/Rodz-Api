import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, gone, validationError, serverError } from '../../shared/errors'
import { getDirectUploadUrl } from '../../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  const target = event.queryStringParameters?.target
  if (target !== 'avatar' && target !== 'cover') {
    return validationError('target must be "avatar" or "cover".')
  }

  try {
    const [[vRow]] = await db.query<any[]>(
      `SELECT v.is_active
         FROM vehicles v
         JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
        WHERE v.id = ? AND vo.customer_id = ?
        LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vRow)          return notFound('Vehicle')
    if (!vRow.is_active) return gone('Vehicle')

    const { uploadUrl, imageId } = await getDirectUploadUrl(
      `vehicle-${target}-${vehicleId}`,
      {
        type:       target === 'avatar' ? 'vehicle_avatar' : 'vehicle_cover',
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
