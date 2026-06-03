import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { buildBooking, bookingError, getAllowedStoreIds } from './_helpers'

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
      'SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL LIMIT 1',
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

    // ── Resolve hoist label ────────────────────────────────────────────────
    let hoistLabel: string | null = booking.assigned_hoist_label
    if (assignedHoistId !== undefined) {
      if (assignedHoistId === null) {
        hoistLabel = null
      } else {
        const [[hoistRow]] = await db.query<any[]>(
          'SELECT label FROM hoists WHERE id = ? LIMIT 1',
          [assignedHoistId],
        )
        hoistLabel = hoistRow?.label ?? null
      }
    }

    // ── Resolve staff label ────────────────────────────────────────────────
    let staffLabel: string | null = booking.assigned_staff_label
    if (assignedStaffId !== undefined) {
      if (assignedStaffId === null) {
        staffLabel = null
      } else {
        const [[staffRow]] = await db.query<any[]>(
          `SELECT CONCAT(LEFT(first_name, 1), '. ', last_name) AS label FROM staff WHERE id = ? LIMIT 1`,
          [assignedStaffId],
        )
        staffLabel = staffRow?.label ?? null
      }
    }

    // ── Update ─────────────────────────────────────────────────────────────
    await db.query<any>(
      `UPDATE bookings
       SET status               = COALESCE(?, status),
           assigned_hoist_id    = ?,
           assigned_hoist_label = ?,
           assigned_staff_id    = ?,
           assigned_staff_label = ?,
           drop_off_time        = ?,
           updated_at           = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [
        status ?? null,
        assignedHoistId !== undefined ? assignedHoistId : booking.assigned_hoist_id,
        hoistLabel,
        assignedStaffId !== undefined ? assignedStaffId : booking.assigned_staff_id,
        staffLabel,
        dropOffTime !== undefined ? dropOffTime : booking.drop_off_time,
        id,
      ],
    )

    const [[updated]] = await db.query<any[]>('SELECT * FROM bookings WHERE id = ? LIMIT 1', [id])
    return ok({ booking: buildBooking(updated) })
  } catch (err) {
    return serverError(err)
  }
}
