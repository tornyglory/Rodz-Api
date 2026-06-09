import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { buildJob, jobError, getJobServices, getAllowedStoreIds, JOB_SELECT_BY_ID } from './_helpers'
import { sendWorkCommencedEmail, sendWorkCompleteEmail } from '../shared/emailTemplates'

const ready = bootstrap()

const VALID_STATUSES = ['open', 'in_progress', 'awaiting_parts', 'awaiting_approval', 'completed', 'cancelled']
const TIME_RE = /^\d{2}:\d{2}$/

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    // ── Fetch job ──────────────────────────────────────────────────────────
    const [[job]] = await db.query<any[]>(
      'SELECT j.id, j.store_id, j.hoist_id, j.status, j.booking_id FROM service_jobs j WHERE j.id = ? LIMIT 1',
      [id],
    )
    if (!job) return jobError(404, 'JOB_NOT_FOUND', 'Job not found.')

    // ── Access check ───────────────────────────────────────────────────────
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(job.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { status, startTime, hoistId, assignedStaffId, notes, odometerIn } = body

    if (status === undefined && startTime === undefined && hoistId === undefined && assignedStaffId === undefined && notes === undefined && odometerIn === undefined) {
      return validationError('No valid fields to update.')
    }

    // Technician cannot reassign hoist
    if (hoistId !== undefined && ctx.role === 'technician') return forbidden()

    // ── Validate ───────────────────────────────────────────────────────────
    if (status != null && !VALID_STATUSES.includes(String(status))) {
      return validationError(`status must be one of: ${VALID_STATUSES.join(', ')}.`)
    }
    if (startTime != null && !TIME_RE.test(String(startTime))) {
      return validationError('startTime must be in HH:MM format.')
    }

    // ── Build job field updates ────────────────────────────────────────────
    const updates: [string, unknown][] = []

    if (status != null) updates.push(['status', status])
    if (startTime !== undefined) updates.push(['scheduled_time', startTime ? `${startTime}:00` : null])
    if (notes !== undefined) updates.push(['customer_notes', notes ?? null])
    if (odometerIn !== undefined) updates.push(['odometer_in', odometerIn ?? null])

    if (hoistId !== undefined && hoistId !== null) {
      // Resolve sort_order on target hoist
      const [[{ maxOrder }]] = await db.query<any[]>(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS maxOrder
         FROM service_jobs WHERE hoist_id = ? AND status NOT IN ('completed','invoiced','cancelled')`,
        [hoistId],
      )
      updates.push(['hoist_id', hoistId])
      updates.push(['sort_order', maxOrder])
    }

    if (updates.length > 0) {
      const set    = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), id]
      await db.query(`UPDATE service_jobs SET ${set} WHERE id = ?`, values)
    }

    // ── Update tech assignment ─────────────────────────────────────────────
    if (assignedStaffId !== undefined) {
      await db.query(
        `DELETE FROM service_job_staff WHERE service_job_id = ? AND role_on_job = 'lead_mechanic'`,
        [id],
      )
      if (assignedStaffId != null) {
        await db.query(
          `INSERT INTO service_job_staff (service_job_id, staff_id, role_on_job, created_at) VALUES (?, ?, 'lead_mechanic', NOW())`,
          [id, assignedStaffId],
        )
      }
    }

    const [[updatedRow]] = await db.query<any[]>(JOB_SELECT_BY_ID, [id])
    const servicesMap = await getJobServices(db, [Number(id)])
    const result = buildJob(updatedRow, servicesMap.get(Number(id)) ?? [])
    if (status === 'in_progress') await sendWorkCommencedEmail(db, result)
    if (status === 'completed')   await sendWorkCompleteEmail(db, result)
    return ok({ job: result })
  } catch (err) {
    return serverError(err)
  }
}
