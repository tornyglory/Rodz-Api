import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, shapeMedia, shapeModification, ModificationMedia } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{id}/modifications
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT id, vehicle_id, category, name, brand, description, installed_at, installed_by,
              cost_aud, status, removed_at, kept_with_sale, is_public, cover_image_id,
              created_at, updated_at
       FROM vehicle_modifications
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY category ASC, id DESC`,
      [vehicleId],
    )

    // Batch-load media in one query.
    const ids = rows.map((r: any) => Number(r.id))
    const mediaByMod = new Map<number, ModificationMedia[]>()
    if (ids.length > 0) {
      const [mediaRows] = await db.query<any[]>(
        `SELECT id, modification_id, kind, image_id, caption, sort_order, amount_aud,
                supplier, purchased_at, expense_event_id, created_at
         FROM vehicle_modification_media
         WHERE modification_id IN (?)
         ORDER BY sort_order ASC, id ASC`,
        [ids],
      )
      for (const r of mediaRows) {
        const modId = Number(r.modification_id)
        if (!mediaByMod.has(modId)) mediaByMod.set(modId, [])
        mediaByMod.get(modId)!.push(shapeMedia(r))
      }
    }

    const modifications = rows.map((r: any) => shapeModification(r, mediaByMod.get(Number(r.id)) ?? []))

    return ok({ modifications })
  } catch (err) {
    return serverError(err)
  }
}
