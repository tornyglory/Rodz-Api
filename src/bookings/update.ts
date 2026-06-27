import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import {
  buildBooking, bookingError, getAllowedStoreIds,
  getBookingServices, setBookingServices, BOOKING_SELECT_BY_ID,
} from './_helpers'
import { generateJobNumber, buildJob, getJobServices, JOB_SELECT_BY_ID } from '../jobs/_helpers'
import { buildHoist, HOIST_SELECT_BY_ID } from '../hoists/_helpers'
import { sendBookingConfirmedEmail } from '../shared/emailTemplates'
import { pushToStore } from '../shared/wsPush'

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
    const { status, assignedHoistId, assignedStaffId, dropOffTime, services, courtesyCar } = body

    if (
      status === undefined &&
      assignedHoistId === undefined &&
      assignedStaffId === undefined &&
      dropOffTime === undefined &&
      services === undefined &&
      courtesyCar === undefined
    ) {
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

    // ── Validate services if provided ──────────────────────────────────────
    if (services !== undefined) {
      if (!Array.isArray(services) || services.length === 0) {
        return validationError('services must be a non-empty array.')
      }
      for (const s of services as any[]) {
        if (!s.serviceTypeId) return validationError('Each service must include a serviceTypeId.')
      }
      const serviceTypeIds = (services as any[]).map((s) => s.serviceTypeId)
      const placeholders = serviceTypeIds.map(() => '?').join(',')
      const [stRows] = await db.query<any[]>(
        `SELECT id FROM service_types WHERE id IN (${placeholders}) AND is_active = 1`,
        serviceTypeIds,
      )
      if (stRows.length !== serviceTypeIds.length) {
        return validationError('One or more service types are invalid or inactive.')
      }
    }

    // ── Build booking field updates ────────────────────────────────────────
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
    if (courtesyCar !== undefined)     updates.push(['courtesy_car_requested', courtesyCar ? 1 : 0])

    if (dropOffTime !== undefined) {
      updates.push(['booking_time', dropOffTime ? `${dropOffTime}:00` : '00:00:00'])
    }

    if (updates.length > 0) {
      const set    = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), id]
      await db.query<any>(`UPDATE bookings SET ${set} WHERE id = ?`, values)
    }

    // ── Replace services if provided ───────────────────────────────────────
    if (services !== undefined) {
      await setBookingServices(db, Number(id), services as any[])
    }

    // ── Auto-create job on confirm ─────────────────────────────────────────
    if (status === 'confirmed') {
      const [[existingJob]] = await db.query<any[]>(
        'SELECT id FROM service_jobs WHERE booking_id = ? LIMIT 1',
        [id],
      )

      if (!existingJob) {
        const hoistIdForJob = assignedHoistId !== undefined ? assignedHoistId : booking.hoist_id

        if (hoistIdForJob) {
          // Inherit hoist's permanent tech (prefer body's assignedStaffId)
          const [[hoistRow]] = await db.query<any[]>(
            'SELECT assigned_staff_id FROM hoists WHERE id = ? LIMIT 1',
            [hoistIdForJob],
          )
          const techId =
            assignedStaffId !== undefined
              ? assignedStaffId
              : hoistRow?.assigned_staff_id ?? null

          // Resolve start time
          const rawTime = dropOffTime !== undefined
            ? (dropOffTime ? String(dropOffTime) : null)
            : (booking.booking_time && String(booking.booking_time) !== '00:00:00'
              ? String(booking.booking_time).slice(0, 5)
              : null)
          const startTime = rawTime ?? (booking.slot === 'morning' ? '08:00' : '13:00')

          // Resolve sort_order (append to active jobs on this hoist)
          const [[{ maxOrder }]] = await db.query<any[]>(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS maxOrder
             FROM service_jobs WHERE hoist_id = ? AND status NOT IN ('completed','invoiced','cancelled')`,
            [hoistIdForJob],
          )

          const jobNumber = await generateJobNumber(db)

          const [jobResult] = await db.query<any>(
            `INSERT INTO service_jobs
               (job_number, booking_id, hoist_id, store_id, customer_id, vehicle_id,
                slot, scheduled_time, sort_order, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
            [
              jobNumber, id, hoistIdForJob, booking.store_id,
              booking.customer_id, booking.vehicle_id,
              booking.slot, `${startTime}:00`, maxOrder,
            ],
          )

          if (techId) {
            await db.query(
              `INSERT INTO service_job_staff (service_job_id, staff_id, role_on_job, created_at)
               VALUES (?, ?, 'lead_mechanic', NOW())`,
              [jobResult.insertId, techId],
            )
          }

          // Push new job to connected tabs so it appears on the board without refresh
          const newJobId = jobResult.insertId
          const [[newJobRow]] = await db.query<any[]>(JOB_SELECT_BY_ID, [newJobId])
          if (newJobRow) {
            const svcMap = await getJobServices(db, [newJobId])
            const newJob = buildJob(newJobRow, svcMap.get(newJobId) ?? [])
            await pushToStore(db, booking.store_id, { type: 'job_updated', job: newJob }).catch(() => {})
            const [[hoistRow]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [hoistIdForJob])
            if (hoistRow) {
              await pushToStore(db, booking.store_id, { type: 'hoist_updated', hoist: buildHoist(hoistRow) }).catch(() => {})
            }
          }
        }
      }
    }

    const [[updatedRow]] = await db.query<any[]>(BOOKING_SELECT_BY_ID, [id])
    const servicesMap = await getBookingServices(db, [Number(id)])
    const result = buildBooking(updatedRow, servicesMap.get(Number(id)) ?? [])
    if (status === 'confirmed') await sendBookingConfirmedEmail(db, result)
    return ok({ booking: result })
  } catch (err) {
    return serverError(err)
  }
}
