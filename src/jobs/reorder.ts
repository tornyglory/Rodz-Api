import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { jobError, getAllowedStoreIds } from './_helpers'
import { buildHoist, HOIST_SELECT_BY_ID } from '../hoists/_helpers'
import { pushToStore } from '../shared/wsPush'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const hoistId = event.pathParameters?.id

  try {
    // ── Fetch hoist ────────────────────────────────────────────────────────
    const [[hoist]] = await db.query<any[]>(
      'SELECT id, store_id FROM hoists WHERE id = ? AND is_active = 1 LIMIT 1',
      [hoistId],
    )
    if (!hoist) return jobError(404, 'HOIST_NOT_FOUND', 'Hoist not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(hoist.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { date, jobIds } = body

    if (!date) return validationError('date is required.')
    if (!Array.isArray(jobIds) || jobIds.length === 0) return validationError('jobIds must be a non-empty array.')

    // ── Verify all jobIds belong to this hoist on this date ────────────────
    const placeholders = jobIds.map(() => '?').join(',')
    const [validJobs] = await db.query<any[]>(
      `SELECT j.id, j.scheduled_time, j.slot,
              COALESCE(
                (SELECT SUM(svc.labour_hours_estimate * 60)
                 FROM booking_services bs
                 JOIN service_types svc ON svc.id = bs.service_type_id
                 WHERE bs.booking_id = j.booking_id),
                60
              ) AS duration_mins
       FROM service_jobs j
       JOIN bookings b ON b.id = j.booking_id
       WHERE j.id IN (${placeholders}) AND j.hoist_id = ? AND b.booking_date = ?`,
      [...jobIds, hoistId, date],
    )

    if (validJobs.length !== jobIds.length) {
      return validationError('One or more jobIds do not belong to this hoist on this date.')
    }

    // ── Build ordered list in the requested sequence ────────────────────────
    const jobMap = new Map(validJobs.map((j: any) => [j.id, j]))
    const ordered = (jobIds as number[]).map((jid) => jobMap.get(jid)).filter(Boolean)

    // Anchor = earliest existing start_time, or slot default
    const withTime = ordered.filter((j: any) => j.scheduled_time && String(j.scheduled_time) !== '00:00:00')
    let anchor = withTime.length > 0
      ? String(withTime[0].scheduled_time).slice(0, 5)
      : ordered[0].slot === 'morning' ? '08:00' : '13:00'

    // Cascade: walk ordered list, compute each start_time from previous job's end
    let currentMins = timeToMins(anchor)
    const results: { id: number; sortOrder: number; startTime: string; slot: string }[] = []

    for (let i = 0; i < ordered.length; i++) {
      const job = ordered[i] as any
      const startTime = minsToTime(currentMins)
      const slot = currentMins < 12 * 60 ? 'morning' : 'afternoon'
      results.push({ id: job.id, sortOrder: i + 1, startTime, slot })

      await db.query(
        'UPDATE service_jobs SET sort_order = ?, scheduled_time = ?, slot = ? WHERE id = ?',
        [i + 1, `${startTime}:00`, slot, job.id],
      )

      currentMins += Number(job.duration_mins) || 60
    }

    await pushToStore(db, hoist.store_id, { type: 'jobs_reordered', jobs: results }).catch(() => {})
    const [[hoistRow]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [hoistId])
    if (hoistRow) {
      await pushToStore(db, hoist.store_id, { type: 'hoist_updated', hoist: buildHoist(hoistRow) }).catch(() => {})
    }

    return ok({ jobs: results })
  } catch (err) {
    return serverError(err)
  }
}

function timeToMins(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minsToTime(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
