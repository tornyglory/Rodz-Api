import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { verifyImage } from '../../../shared/cloudflare'
import { writeToDataLake } from '../../../shared/dataLake'
import { refreshVehicleSummaries } from '../../../shared/summaries'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, shapeMedia } from './_helpers'

const ready = bootstrap()

// POST /c/vehicles/{id}/modifications/{modId}/media
//
// Attach a photo or receipt to a modification. When kind='receipt', we
// also spawn an expense-tracker entry (s3_event_index + S3 detail, same
// path as `POST /c/vehicles/{id}/expenses`) with category='modification'
// so the spend rolls into the customer's running totals. The media row
// stores the resulting s3_event_index.id as `expense_event_id` so the
// two are linked both ways.
//
// Body:
//   {
//     "imageId":     "abc-123",        // required — Cloudflare Images id
//     "kind":        "photo" | "receipt",  // default "photo"
//     "caption":     string?,
//     "sortOrder":   number?,
//     // Receipt-only:
//     "amountAud":   number,           // required when kind='receipt'
//     "supplier":    string?,
//     "purchasedAt": "YYYY-MM-DD"?     // defaults to today if omitted
//   }
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const modId     = Number(event.pathParameters?.modId)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    const [[mod]] = await db.query<any[]>(
      `SELECT id, name, category FROM vehicle_modifications
       WHERE id = ? AND vehicle_id = ? AND deleted_at IS NULL LIMIT 1`,
      [modId, vehicleId],
    )
    if (!mod) return notFound('Modification')

    let body: Record<string, unknown>
    try { body = JSON.parse(event.body ?? '{}') } catch { return validationError('Body must be JSON.') }

    const imageId = typeof body.imageId === 'string' ? body.imageId.trim() : ''
    if (!imageId) return validationError('imageId is required.')

    const exists = await verifyImage(imageId)
    if (!exists) return validationError('Image not found in Cloudflare.')

    const kind = body.kind === 'receipt' ? 'receipt' : 'photo'
    const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 300) || null : null
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0

    let amountAud: number | null = null
    let supplier: string | null = null
    let purchasedAt: string | null = null
    let expenseEventId: number | null = null

    if (kind === 'receipt') {
      // Amount is required so the expense-tracker entry is meaningful.
      if (body.amountAud == null) return validationError('amountAud is required when kind is receipt.')
      const n = Number(body.amountAud)
      if (!Number.isFinite(n) || n < 0) return validationError('amountAud must be a non-negative number.')
      amountAud = n

      supplier = typeof body.supplier === 'string' ? body.supplier.trim().slice(0, 200) || null : null
      purchasedAt =
        typeof body.purchasedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.purchasedAt)
          ? body.purchasedAt
          : new Date().toISOString().slice(0, 10)

      // Create the expense-tracker entry — same shape as
      // `POST /c/vehicles/{id}/expenses` produces, with category
      // 'modification' and a reference back to the mod.
      const payload = {
        vehicleId,
        customerId:      ctx.customerId,
        category:        'modification',
        merchantName:    supplier,
        amount:          amountAud,
        expenseDate:     purchasedAt,
        imageId,
        extractionStatus: 'manual',
        notes:            `Modification: ${mod.name}`,
        modificationId:   modId,
        modificationName: mod.name,
        modificationCategory: mod.category,
        createdAt:        new Date().toISOString(),
      }
      const s3Result = await writeToDataLake('expenses', payload)
      if (!s3Result) return serverError('Data lake write failed')

      const [ins]: any = await db.query(
        `INSERT INTO s3_event_index (vehicle_id, customer_id, event_type, s3_key, event_date, summary, amount_aud, category)
         VALUES (?, ?, 'expenses', ?, ?, ?, ?, 'modification')`,
        [vehicleId, ctx.customerId, s3Result.key, purchasedAt, s3Result.summary, amountAud],
      )
      expenseEventId = Number(ins.insertId)

      await refreshVehicleSummaries(db, vehicleId).catch(() => { /* summary refresh is fire-and-forget */ })
    }

    const [insMedia]: any = await db.query(
      `INSERT INTO vehicle_modification_media
         (modification_id, kind, image_id, caption, sort_order, amount_aud, supplier, purchased_at, expense_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [modId, kind, imageId, caption, sortOrder, amountAud, supplier, purchasedAt, expenseEventId],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT id, kind, image_id, caption, sort_order, amount_aud, supplier, purchased_at,
              expense_event_id, created_at
       FROM vehicle_modification_media WHERE id = ? LIMIT 1`,
      [insMedia.insertId],
    )
    return created({ media: shapeMedia(row) })
  } catch (err) {
    return serverError(err)
  }
}
