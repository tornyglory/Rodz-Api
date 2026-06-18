import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, validationError, serverError } from '../shared/errors'
import { verifyImage } from '../shared/cloudflare'
import { buildPhoto } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { imageId, vehicleRego, quoteId, quoteItemId, jobCardItemId, invoiceId, invoiceItemId, caption } = body

    if (!imageId)     return validationError('imageId is required.')
    if (!vehicleRego) return validationError('vehicleRego is required.')

    const exists = await verifyImage(imageId)
    if (!exists) return validationError('Image not found on Cloudflare — upload may have failed.')

    const [result] = await db.query<any>(
      `INSERT INTO photos (image_id, vehicle_rego, quote_id, quote_item_id, job_card_item_id, invoice_id, invoice_item_id, uploaded_by, caption)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [imageId, vehicleRego, quoteId ?? null, quoteItemId ?? null, jobCardItemId ?? null, invoiceId ?? null, invoiceItemId ?? null, ctx.staffId, caption ?? null],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT id, image_id, vehicle_rego, quote_id, quote_item_id, job_card_item_id, invoice_id, invoice_item_id, uploaded_by, caption, created_at
       FROM photos WHERE id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ photo: buildPhoto(row) })
  } catch (err) {
    return serverError(err)
  }
}
