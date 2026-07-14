import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { safeDel } from '../../shared/redis'
import { getPool } from '../../shared/db'
import { ok, validationError, forbidden, serverError } from '../../shared/errors'
import { verifyImage } from '../../shared/cloudflare'
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

    const body = JSON.parse(event.body ?? '{}') as { imageId?: string }
    if (!body.imageId) return validationError('imageId is required.')

    const exists = await verifyImage(body.imageId)
    if (!exists) return validationError('Image not found in Cloudflare.')

    await db.query(
      'UPDATE vehicles SET avatar_image_id = ?, updated_at = NOW() WHERE id = ?',
      [body.imageId, vehicleId],
    )
    await safeDel(`vehicle:${vehicleId}:context`)

    return ok({ imageId: body.imageId })
  } catch (err) {
    return serverError(err)
  }
}
