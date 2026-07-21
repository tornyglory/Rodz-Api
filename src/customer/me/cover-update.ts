import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { verifyImage } from '../../shared/cloudflare'
import { getCustomerContext } from '../_helpers'
import { safeDel } from '../../shared/redis'

const ready = bootstrap()

// POST /c/me/cover
// Body: { imageId: string } — the Cloudflare Images id returned from
// GET /c/me/avatar/upload-url (the endpoint is shared: it hands back
// a generic direct-upload URL and imageId, and the frontend calls
// this handler to save it as the cover, or /c/me/avatar to save it
// as the avatar).
//
// Sending `imageId: null` clears the cover.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as { imageId?: string | null }

    // Explicit clear.
    if (body.imageId === null) {
      await db.query(
        'UPDATE customers SET cover_image_id = NULL, updated_at = NOW() WHERE id = ?',
        [ctx.customerId],
      )
      await safeDel(`customer:${ctx.customerId}:profile`)
      return ok({ imageId: null })
    }

    if (!body.imageId) return validationError('imageId is required.')

    const exists = await verifyImage(body.imageId)
    if (!exists) return validationError('Image not found in Cloudflare.')

    await db.query(
      'UPDATE customers SET cover_image_id = ?, updated_at = NOW() WHERE id = ?',
      [body.imageId, ctx.customerId],
    )
    await safeDel(`customer:${ctx.customerId}:profile`)

    return ok({ imageId: body.imageId })
  } catch (err) {
    return serverError(err)
  }
}
