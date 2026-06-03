import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { buildBooking, bookingError, getAllowedStoreIds, BOOKING_SELECT_BY_ID } from './_helpers'

const ready = bootstrap()

const VALID_STATUSES = ['pending', 'confirmed', 'rejected']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    // ── Fetch booking ──────────────────────────────────────────────────────
    const [[booking]] = await db.query<any[]>(
      'SELECT * FROM bookings WHERE id = ? AND cancelled_at IS NULL LIMIT 1',
      [id],
    )
    if (!booking) return bookingError(404, 'BOOKING_NOT_FOUND', 'Booking not found.')

    // ── Store access check ─────────────────────────────────────────────────
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(booking.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { status, assignedHoistId, assignedStaffId, dropOffTime } = body

    if (status == null && assignedHoistId === undefined && assignedStaffId === undefined && dropOffTime === undefined) {
      return validationError('No valid fields to update.')
    }

    // ── Status transition guard ────────────────────────────────────────────
    if (status != null) {
      if (!VALID_STATUSES.includes(String(status))) {
        return validationError(`status must be one of: ${VALID_STATUSES.join(', ')}.`)
      }
      if (booking.status === 'confirmed' && status === 'pending') {
        return bookingError(422, 'INVALID_STATUS_TRANSITION', 'A confirmed booking cannot be set back to pending.')
      }
    }

    // ── Build updates ──────────────────────────────────────────────────────
    const updates: [string, unknown][] = []

    if (status != null) {
      updates.push(['status', status])
      if (status === 'confirmed') {
        updates.push(['confirmed_at', new Date()])
        updates.push(['confirmed_by_staff_id', ctx.staffId])
      }
    }

    if (assignedHoistId !== undefined) updates.push(['hoist_id', assignedHoistId])
    if (assignedStaffId !== undefined) updates.push(['assigned_staff_id', assignedStaffId])

    if (dropOffTime !== undefined) {
      updates.push(['booking_time', dropOffTime ? `${dropOffTime}:00` : null])
    }

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]
    await db.query<any>(`UPDATE bookings SET ${set} WHERE id = ?`, values)

    const [[updated]] = await db.query<any[]>(BOOKING_SELECT_BY_ID, [id])
    return ok({ booking: buildBooking(updated) })
  } catch (err) {
    return serverError(err)
  }
}
