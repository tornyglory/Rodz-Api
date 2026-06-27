import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { rollingRange, resolveStoreScope, pct, RollingPeriod } from './_helpers'

const ready = bootstrap()

const VALID_PERIODS = new Set(['7d', '30d', '3m'])
const ALL_STATUSES  = ['completed', 'in_progress', 'open', 'awaiting_parts', 'awaiting_approval']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const qs  = event.queryStringParameters ?? {}

  const period = (qs.period ?? '30d') as RollingPeriod
  if (!VALID_PERIODS.has(period)) return validationError('period must be 7d, 30d, or 3m.')

  try {
    const scope = await resolveStoreScope(db, ctx.role, ctx.staffId, ctx.storeId, qs.store)
    if (scope.ids.length === 0) {
      return ok({ period, store: scope.label, statusBreakdown: [], topServices: [], techLeaderboard: [] })
    }

    const { from, to } = rollingRange(period)
    const ph = scope.ids.map(() => '?').join(',')

    const [statusRows, serviceRows, techRows, byStoreRows] = await Promise.all([
      // Status breakdown — non-cancelled jobs in the period
      db.query<any[]>(
        `SELECT sj.status, COUNT(*) AS cnt
         FROM service_jobs sj
         JOIN bookings b ON b.id = sj.booking_id
         WHERE b.booking_date BETWEEN ? AND ?
           AND sj.status != 'cancelled'
           AND sj.store_id IN (${ph})
         GROUP BY sj.status`,
        [from, to, ...scope.ids],
      ),
      // Top services via booking_services → service_types
      db.query<any[]>(
        `SELECT st.name AS service, COUNT(*) AS cnt
         FROM service_jobs sj
         JOIN bookings b ON b.id = sj.booking_id
         JOIN booking_services bs ON bs.booking_id = b.id
         JOIN service_types st ON st.id = bs.service_type_id
         WHERE b.booking_date BETWEEN ? AND ?
           AND sj.status != 'cancelled'
           AND sj.store_id IN (${ph})
         GROUP BY st.id, st.name
         ORDER BY cnt DESC
         LIMIT 6`,
        [from, to, ...scope.ids],
      ),
      // Tech leaderboard via service_job_staff
      db.query<any[]>(
        `SELECT
           CONCAT(s.first_name, ' ', LEFT(s.last_name, 1)) AS name,
           s.id AS tech_id,
           COUNT(sj.id)                                    AS total,
           SUM(sj.status = 'completed')                   AS completed,
           SUM(sj.status = 'in_progress')                 AS in_progress
         FROM service_jobs sj
         JOIN bookings b ON b.id = sj.booking_id
         JOIN service_job_staff sjs ON sjs.service_job_id = sj.id AND sjs.role_on_job = 'lead_mechanic'
         JOIN staff s ON s.id = sjs.staff_id
         WHERE b.booking_date BETWEEN ? AND ?
           AND sj.status != 'cancelled'
           AND sj.store_id IN (${ph})
         GROUP BY s.id, s.first_name, s.last_name
         ORDER BY completed DESC
         LIMIT 10`,
        [from, to, ...scope.ids],
      ),
      // byStore (only runs when scope.isAll — still cheap for few stores)
      scope.isAll
        ? db.query<any[]>(
            `SELECT
               st.name AS store_name,
               COUNT(sj.id)                  AS total,
               SUM(sj.status = 'completed')  AS completed
             FROM service_jobs sj
             JOIN bookings b ON b.id = sj.booking_id
             JOIN stores st ON st.id = sj.store_id
             WHERE b.booking_date BETWEEN ? AND ?
               AND sj.status != 'cancelled'
               AND sj.store_id IN (${ph})
             GROUP BY sj.store_id, st.name
             ORDER BY total DESC`,
            [from, to, ...scope.ids],
          )
        : Promise.resolve([[]] as [any[]]),
    ])

    const [statusData] = statusRows
    const [serviceData] = serviceRows
    const [techData]    = techRows
    const [byStoreData] = byStoreRows

    // Build status breakdown — always 5 rows
    const statusMap = new Map<string, number>()
    let totalJobs = 0
    for (const r of statusData) {
      statusMap.set(r.status, Number(r.cnt))
      totalJobs += Number(r.cnt)
    }

    const statusBreakdown = ALL_STATUSES.map(s => ({
      status:     s,
      label:      s.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      count:      statusMap.get(s) ?? 0,
      percentage: pct(statusMap.get(s) ?? 0, totalJobs),
    }))

    // Top services — percentage relative to top
    const topCount = serviceData.length > 0 ? Number(serviceData[0].cnt) : 1
    const topServices = serviceData.map((r: any) => ({
      service:    r.service,
      count:      Number(r.cnt),
      percentage: pct(Number(r.cnt), topCount),
    }))

    // Tech leaderboard
    const techLeaderboard = techData.map((r: any) => ({
      name:       r.name,
      techId:     Number(r.tech_id),
      total:      Number(r.total),
      completed:  Number(r.completed),
      inProgress: Number(r.in_progress),
      rate:       pct(Number(r.completed), Number(r.total)),
    }))

    const result: any = { period, store: scope.label, statusBreakdown, topServices, techLeaderboard }

    if (scope.isAll) {
      result.byStore = byStoreData.map((r: any) => ({
        store:     r.store_name.replace(/^Rodz /, ''),
        total:     Number(r.total),
        completed: Number(r.completed),
      }))
    }

    return ok(result)
  } catch (err) {
    return serverError(err)
  }
}
