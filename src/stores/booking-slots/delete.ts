import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { guardStaffStoreAccess } from './_helpers'

const ready = bootstrap()

// DELETE /stores/{id}/booking-slots/{slotId}
// Hard-deletes the slot. Since customers reference slots by `time` at
// booking-create time (not by id), existing bookings aren't touched —
// they keep their booking_time value. Prefer PATCH is_active=false to
// hide a slot from customers while preserving history.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)
  const slotId  = Number(event.pathParameters?.slotId)

  if (!storeId || !slotId) return validationError('store id and slot id are required.')
  const guard = await guardStaffStoreAccess(db, ctx, storeId)
  if (guard) return guard

  try {
    const [result] = await db.query<any>(
      'DELETE FROM store_booking_slots WHERE id = ? AND store_id = ?',
      [slotId, storeId],
    )
    if (result.affectedRows === 0) return notFound('Slot')
    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
