import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { created, validationError, notFound, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'
import { findActiveSlotByTime, deriveSlotEnum, computeSlotAvailability } from '../../shared/bookingSlots'

const ready = bootstrap()

const VALID_TYPES = ['drop_off', 'wait', 'pickup']

function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function toDate(v: any): string {
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { vehicleId, storeId, date, time, hoistId, type, serviceTypeIds, notes } = body

    if (!vehicleId)                                              return validationError('vehicleId is required.')
    if (!storeId)                                                return validationError('storeId is required.')
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))            return validationError('date must be YYYY-MM-DD format.')
    if (!time || !/^\d{2}:\d{2}$/.test(String(time)))          return validationError('time must be in HH:MM format.')
    if (hoistId == null || !Number.isFinite(Number(hoistId)))   return validationError('hoistId is required.')
    if (!type || !VALID_TYPES.includes(type))                    return validationError('type must be "drop_off", "wait", or "pickup".')
    if (!Array.isArray(serviceTypeIds) || !serviceTypeIds.length) return validationError('serviceTypeIds must be a non-empty array.')
    if (notes != null && String(notes).length > 1000)            return validationError('notes must be 1000 characters or fewer.')

    const today = new Date().toISOString().slice(0, 10)
    if (date <= today) return validationError('date must be in the future.')

    const [[storeRow]] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [Number(storeId)],
    )
    if (!storeRow) return notFound('Store')

    // Verify the requested time matches an active slot at this store — no
    // free-form time entry, only what staff have configured.
    const slot = await findActiveSlotByTime(db, Number(storeId), String(time))
    if (!slot) return validationError(`time ${time} is not a bookable slot at this store.`)

    // Availability check — is the slot open, and is the requested hoist
    // actually free at that time for the requested service types?
    const availability = await computeSlotAvailability(db, Number(storeId), date, serviceTypeIds)
    const targetSlot = availability.slots.find(s => s.id === slot.id)
    if (!availability.storeOpen || !targetSlot?.available) {
      return validationError(`slot at ${time} on ${date} is not available (${targetSlot?.reason ?? availability.reason ?? 'unavailable'}).`)
    }
    const chosenTech = targetSlot.techs.find(t => t.hoistId === Number(hoistId))
    if (!chosenTech) {
      return validationError(`hoist ${hoistId} is not available for this slot + service.`)
    }

    const bookingTime  = `${String(time)}:00`
    const bookingEnd   = slot.endTime         // 'HH:MM:SS' from the slot row
    const durationMins = (() => {
      const [sh, sm] = bookingTime.slice(0, 5).split(':').map(Number)
      const [eh, em] = bookingEnd.slice(0, 5).split(':').map(Number)
      return Math.max(15, (eh * 60 + em) - (sh * 60 + sm))   // floor at 15 min just in case
    })()
    const legacySlot   = deriveSlotEnum(String(time))

    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id FROM vehicles v JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE v.id = ? AND vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1 LIMIT 1`,
      [Number(vehicleId), ctx.customerId],
    )
    if (!vehicle) return notFound('Vehicle')

    const placeholders = serviceTypeIds.map(() => '?').join(',')
    const [stRows] = await db.query<any[]>(
      `SELECT id FROM service_types WHERE id IN (${placeholders}) AND is_active = 1`,
      serviceTypeIds,
    )
    if (stRows.length !== serviceTypeIds.length) {
      return validationError('One or more service types are invalid or inactive.')
    }

    const [result] = await db.query<any>(
      `INSERT INTO bookings
         (store_id, booking_ref, customer_id, vehicle_id, booking_date, booking_time, end_time,
          estimated_duration_mins, slot, hoist_id, assigned_staff_id, drop_off_type, customer_notes,
          status, booking_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'rodz_app')`,
      [storeRow.id, generateBookingRef(), ctx.customerId, Number(vehicleId), date,
       bookingTime, bookingEnd, durationMins, legacySlot,
       chosenTech.hoistId, chosenTech.staffId ?? null,
       type, notes ?? null],
    )
    const bookingId = result.insertId

    const vals = serviceTypeIds.map(() => '(?,?)').join(',')
    const args = serviceTypeIds.flatMap((id: number) => [bookingId, id])
    await db.query(`INSERT INTO booking_services (booking_id, service_type_id) VALUES ${vals}`, args)

    const [[booking]] = await db.query<any[]>(
      `SELECT b.id, b.booking_ref, b.booking_date, b.booking_time, b.slot, b.drop_off_type, b.status,
              s.name AS store_name, s.suburb AS store_suburb,
              GROUP_CONCAT(st.name ORDER BY st.name SEPARATOR ', ') AS services
       FROM bookings b
       JOIN stores s ON s.id = b.store_id
       LEFT JOIN booking_services bs ON bs.booking_id = b.id
       LEFT JOIN service_types st ON st.id = bs.service_type_id
       WHERE b.id = ? GROUP BY b.id, b.booking_ref, b.booking_date, b.booking_time, b.slot, b.drop_off_type, b.status, s.name, s.suburb`,
      [bookingId],
    )

    const bookingTimeOut = booking.booking_time instanceof Date
      ? booking.booking_time.toISOString().slice(11, 16)
      : String(booking.booking_time).slice(0, 5)

    return created({
      booking: {
        id:         booking.id,
        bookingRef: booking.booking_ref,
        date:       toDate(booking.booking_date),
        time:       bookingTimeOut,        // 'HH:MM'
        slot:       booking.slot,           // legacy — kept for backward compat
        type:       booking.drop_off_type,
        status:     booking.status,
        store:      { name: booking.store_name, suburb: booking.store_suburb },
        hoist:      { id: chosenTech.hoistId, name: chosenTech.hoistName },
        tech:       chosenTech.staffId
          ? { id: chosenTech.staffId, name: chosenTech.name }
          : null,
        services:   booking.services ?? null,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
