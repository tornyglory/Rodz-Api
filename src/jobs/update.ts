import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { buildJob, jobError, getJobServices, getAllowedStoreIds, JOB_SELECT_BY_ID } from './_helpers'
import { buildHoist, HOIST_SELECT_BY_ID } from '../hoists/_helpers'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { sendWorkCommencedEmail, sendWorkCompleteEmail } from '../shared/emailTemplates'
import { notifyStore } from '../shared/staffNotifications'
import { pushToCustomer } from '../shared/push'
import { pushToStore } from '../shared/wsPush'
import { maybeRegenerateSchedule } from '../shared/aiEngines'
import { bumpOdometer } from '../shared/odometer'

const sqsClient = new SQSClient({ region: process.env.REGION ?? 'ap-southeast-2' })

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
    const { status, startTime, hoistId, assignedStaffId, notes, odometerIn, durationMins } = body

    if (status === undefined && startTime === undefined && hoistId === undefined && assignedStaffId === undefined && notes === undefined && odometerIn === undefined && durationMins === undefined) {
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

    if (status != null) {
      updates.push(['status', status])
      if (status === 'in_progress')  updates.push(['started_at',   new Date()])
      if (status === 'completed')    updates.push(['completed_at', new Date()])
      if (status === 'cancelled')    updates.push(['cancelled_at', new Date()])
    }
    if (startTime !== undefined) updates.push(['scheduled_time', startTime ? `${startTime}:00` : null])
    if (durationMins !== undefined) {
      if (!Number.isInteger(durationMins) || Number(durationMins) < 15) {
        return validationError('durationMins must be an integer >= 15.')
      }
      updates.push(['duration_mins', Number(durationMins)])
    }
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

    // Mirror odometer to vehicles so the prediction engine has a fresh
    // reference point. The tech physically read the dashboard, so this is
    // ground truth — backwards writes are allowed here and get logged as
    // corrections (fixes drift from the weekly-bump, initial-signup
    // typos, meter replacements).
    if (odometerIn != null && updatedRow.vehicle_id) {
      const bump = await bumpOdometer(db, Number(updatedRow.vehicle_id), Number(odometerIn), 'job-entry', {
        actorType:      'staff',
        actorId:        Number(ctx.staffId) || null,
        allowBackwards: true,
        sourceRef:      `job:${id}`,
      })
      if (bump.ok && bump.changed) {
        void maybeRegenerateSchedule(db, Number(updatedRow.vehicle_id), Number(odometerIn))
      }
    }

    if (status === 'in_progress') await sendWorkCommencedEmail(db, result)
    if (status === 'completed') {
      await sendWorkCompleteEmail(db, result)
      await notifyStore(db, job.store_id, {
        type:  'job_completed',
        title: 'Job Completed',
        body:  `${result.vehicle ?? result.rego} (${result.rego}) completed${result.tech ? ` by ${result.tech}` : ''}`,
        jobId: Number(id),
      })

      // Customer "car ready" push (non-fatal). Exempt from baseline rate-
      // limit + quiet hours per push.ts config — customer wants to know
      // their car is ready even at 10pm.
      try {
        const storeName = (result.store ?? '').replace(/^Rodz\s+Smart\s+Auto\s+/i, '')
          .replace(/^Rodz\s+/i, '') || (result.store ?? 'Rodz Smart Auto')
        await pushToCustomer(db, Number(result.customerId), {
          type:      'car_ready',
          title:     'Rodz',
          body:      `${result.rego ?? 'Your car'} is ready to collect from ${storeName}. See you soon!`,
          deeplink:  result.vehicleId ? `/account/vehicles/${result.vehicleId}/chat` : '/account',
          eventId:   `job:${result.id}:completed`,
          vehicleId: result.vehicleId ?? null,
        })
      } catch {
        // Non-fatal
      }
      // Send digital logbook email 1 minute after job completion
      const logbookQueueUrl = process.env.LOGBOOK_NOTIFY_QUEUE_URL
      if (logbookQueueUrl && result.rego) {
        try {
          await sqsClient.send(new SendMessageCommand({
            QueueUrl:     logbookQueueUrl,
            MessageBody:  JSON.stringify({ rego: result.rego }),
          }))
        } catch (sqsErr) {
          console.error('Failed to queue logbook notification (non-fatal):', sqsErr)
        }
      }
    }

    // ── Real-time WS push ──────────────────────────────────────────────────
    await pushToStore(db, job.store_id, { type: 'job_updated', job: result }).catch(() => {})

    // Push hoist_updated for old hoist; also new hoist if the job was moved
    const hoistsToRefresh = new Set<number>([job.hoist_id])
    if (hoistId != null) hoistsToRefresh.add(Number(hoistId))
    for (const hid of hoistsToRefresh) {
      const [[hoistRow]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [hid])
      if (hoistRow) {
        await pushToStore(db, job.store_id, { type: 'hoist_updated', hoist: buildHoist(hoistRow) }).catch(() => {})
      }
    }

    return ok({ job: result })
  } catch (err) {
    return serverError(err)
  }
}
