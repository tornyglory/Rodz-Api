import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { guardStaffStoreAccess, shapeSlotResponse } from './_helpers'

const ready = bootstrap()

// GET /stores/{id}/booking-slots
// Staff-only. Returns all slots (active + inactive) so the portal can
// render toggles + hidden slots.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)

  if (!storeId) return validationError('store id is required.')

  const guard = await guardStaffStoreAccess(db, ctx, storeId)
  if (guard) return guard

  try {
    const [[store]] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ? LIMIT 1', [storeId])
    if (!store) return notFound('Store')

    const [rows] = await db.query<any[]>(
      `SELECT id, store_id, slot_time, label, sort_order, is_active, created_at, updated_at
       FROM store_booking_slots WHERE store_id = ? ORDER BY sort_order ASC, slot_time ASC`,
      [storeId],
    )

    return ok({ slots: rows.map(shapeSlotResponse) })
  } catch (err) {
    return serverError(err)
  }
}
