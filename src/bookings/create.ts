import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildBooking, bookingError, getAllowedStoreIds, generateBookingRef, BOOKING_SELECT_BY_ID } from './_helpers'

const ready = bootstrap()

const VALID_TYPES = ['drop_off', 'wait', 'pickup']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { customerId, vehicleId, date, slot, type, store, notes, dropOffTime } = body

    if (!customerId)                                       return validationError('customerId is required.')
    if (!vehicleId)                                        return validationError('vehicleId is required.')
    if (!date)                                             return validationError('date is required.')
    if (!slot || !['morning', 'afternoon'].includes(slot)) return validationError('slot must be "morning" or "afternoon".')
    if (!type || !VALID_TYPES.includes(type))              return validationError(`type must be one of: ${VALID_TYPES.join(', ')}.`)
    if (!store?.trim())                                    return validationError('store is required.')
    if (notes != null && String(notes).length > 1000)      return validationError('notes must be 1000 characters or fewer.')

    const today = new Date().toISOString().slice(0, 10)
    if (date < today) return validationError('date must not be in the past.')

    // ── Store access check ─────────────────────────────────────────────────
    const [[storeRow]] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE name LIKE ? LIMIT 1',
      [`%${String(store).trim()}%`],
    )
    if (!storeRow) return validationError(`Store "${store}" not found.`)

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(storeRow.id)) return forbidden()
    }

    // ── Verify customer ────────────────────────────────────────────────────
    const [[customerRow]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [customerId],
    )
    if (!customerRow) return bookingError(404, 'CUSTOMER_NOT_FOUND', 'No customer with that ID exists.')

    // ── Verify vehicle belongs to customer ─────────────────────────────────
    const [[vehicleRow]] = await db.query<any[]>(
      `SELECT v.id FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE v.id = ? AND vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicleRow) return bookingError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found or does not belong to this customer.')

    // booking_time is NOT NULL — use '00:00:00' when no time is set yet
    const bookingTime = dropOffTime ? `${dropOffTime}:00` : '00:00:00'

    // ── Insert ─────────────────────────────────────────────────────────────
    const [result] = await db.query<any>(
      `INSERT INTO bookings
         (store_id, booking_ref, customer_id, vehicle_id, booking_date, booking_time,
          slot, drop_off_type, customer_notes, status, booking_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'rodz_app')`,
      [storeRow.id, generateBookingRef(), customerId, vehicleId, date, bookingTime, slot, type, notes ?? null],
    )

    const [[row]] = await db.query<any[]>(BOOKING_SELECT_BY_ID, [result.insertId])
    return created({ booking: buildBooking(row) })
  } catch (err) {
    return serverError(err)
  }
}
