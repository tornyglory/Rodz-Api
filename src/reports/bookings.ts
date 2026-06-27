import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, validationError, serverError } from '../shared/errors'
import { rollingRange, resolveStoreScope, pct, RollingPeriod } from './_helpers'

const ready = bootstrap()

const VALID_PERIODS = new Set(['7d', '30d', '3m'])

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
      const emptyFunnel = [
        { stage: 'Total',     count: 0, percentage: 100 },
        { stage: 'Confirmed', count: 0, percentage: 0 },
        { stage: 'Pending',   count: 0, percentage: 0 },
        { stage: 'Rejected',  count: 0, percentage: 0 },
      ]
      return ok({ period, store: scope.label, funnel: emptyFunnel, conversionRate: 0, topBookedServices: [] })
    }

    const { from, to } = rollingRange(period)
    const ph = scope.ids.map(() => '?').join(',')

    const [totalsRows, servicesRows, byStoreRows] = await Promise.all([
      db.query<any[]>(
        `SELECT
           COUNT(*)                          AS total,
           SUM(status = 'confirmed')         AS confirmed,
           SUM(status = 'pending')           AS pending,
           SUM(status = 'rejected')          AS rejected
         FROM bookings
         WHERE booking_date BETWEEN ? AND ?
           AND cancelled_at IS NULL
           AND store_id IN (${ph})`,
        [from, to, ...scope.ids],
      ),
      db.query<any[]>(
        `SELECT st.name AS service, COUNT(*) AS cnt
         FROM bookings b
         JOIN booking_services bs ON bs.booking_id = b.id
         JOIN service_types st ON st.id = bs.service_type_id
         WHERE b.booking_date BETWEEN ? AND ?
           AND b.cancelled_at IS NULL
           AND b.store_id IN (${ph})
         GROUP BY st.id, st.name
         ORDER BY cnt DESC
         LIMIT 5`,
        [from, to, ...scope.ids],
      ),
      scope.isAll
        ? db.query<any[]>(
            `SELECT
               s.name AS store_name,
               COUNT(*)                    AS total,
               SUM(b.status = 'confirmed') AS confirmed
             FROM bookings b
             JOIN stores s ON s.id = b.store_id
             WHERE b.booking_date BETWEEN ? AND ?
               AND b.cancelled_at IS NULL
               AND b.store_id IN (${ph})
             GROUP BY b.store_id, s.name
             ORDER BY total DESC`,
            [from, to, ...scope.ids],
          )
        : Promise.resolve([[]] as [any[]]),
    ])

    const [[totals]] = totalsRows
    const [services]  = servicesRows
    const [byStore]   = byStoreRows

    const total     = Number(totals?.total     ?? 0)
    const confirmed = Number(totals?.confirmed ?? 0)
    const pending   = Number(totals?.pending   ?? 0)
    const rejected  = Number(totals?.rejected  ?? 0)

    const funnel = [
      { stage: 'Total',     count: total,     percentage: 100 },
      { stage: 'Confirmed', count: confirmed, percentage: pct(confirmed, total) },
      { stage: 'Pending',   count: pending,   percentage: pct(pending,   total) },
      { stage: 'Rejected',  count: rejected,  percentage: pct(rejected,  total) },
    ]

    const topCount = services.length > 0 ? Number(services[0].cnt) : 1
    const topBookedServices = services.map((r: any) => ({
      service:    r.service,
      count:      Number(r.cnt),
      percentage: pct(Number(r.cnt), topCount),
    }))

    const result: any = {
      period,
      store: scope.label,
      funnel,
      conversionRate: pct(confirmed, total),
      topBookedServices,
    }

    if (scope.isAll) {
      result.byStore = byStore.map((r: any) => ({
        store:          r.store_name.replace(/^Rodz /, ''),
        total:          Number(r.total),
        confirmed:      Number(r.confirmed),
        conversionRate: pct(Number(r.confirmed), Number(r.total)),
      }))
    }

    return ok(result)
  } catch (err) {
    return serverError(err)
  }
}
