import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { verifyImage } from '../../shared/cloudflare'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as { imageId?: string }
    if (!body.imageId) return validationError('imageId is required.')

    const exists = await verifyImage(body.imageId)
    if (!exists) return validationError('Image not found in Cloudflare.')

    await db.query(
      'UPDATE customers SET avatar_image_id = ?, updated_at = NOW() WHERE id = ?',
      [body.imageId, ctx.customerId],
    )

    return ok({ imageId: body.imageId })
  } catch (err) {
    return serverError(err)
  }
}
