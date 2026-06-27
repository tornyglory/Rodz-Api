import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, validationError, serverError } from '../shared/errors'
import { rollingRange, resolveStoreScope, countWorkingDaysMtoS, RollingPeriod } from './_helpers'

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
    if (scope.ids.length === 0) return ok({ period, store: scope.label, utilisation: 0, hoistBreakdown: [] })

    const { from, to } = rollingRange(period)
    const workingDays   = countWorkingDaysMtoS(from, to)
    const slotsPerHoist = workingDays * 8
    const ph = scope.ids.map(() => '?').join(',')

    const [hoistRows, byStoreRows] = await Promise.all([
      db.query<any[]>(
        `SELECT
           h.id AS hoist_id, h.name AS label, h.store_id,
           COUNT(sj.id) AS job_count
         FROM hoists h
         LEFT JOIN service_jobs sj
           ON sj.hoist_id = h.id
           AND sj.status != 'cancelled'
           AND EXISTS (
             SELECT 1 FROM bookings b
             WHERE b.id = sj.booking_id
               AND b.booking_date BETWEEN ? AND ?
           )
         WHERE h.is_active = 1
           AND h.store_id IN (${ph})
         GROUP BY h.id, h.name, h.store_id
         ORDER BY h.store_id, h.id`,
        [from, to, ...scope.ids],
      ),
      scope.isAll
        ? db.query<any[]>(
            `SELECT
               s.name AS store_name,
               h.id AS hoist_id,
               COUNT(sj.id) AS job_count
             FROM hoists h
             JOIN stores s ON s.id = h.store_id
             LEFT JOIN service_jobs sj
               ON sj.hoist_id = h.id
               AND sj.status != 'cancelled'
               AND EXISTS (
                 SELECT 1 FROM bookings b
                 WHERE b.id = sj.booking_id
                   AND b.booking_date BETWEEN ? AND ?
               )
             WHERE h.is_active = 1
               AND h.store_id IN (${ph})
             GROUP BY s.id, s.name, h.id
             ORDER BY s.id`,
            [from, to, ...scope.ids],
          )
        : Promise.resolve([[]] as [any[]]),
    ])

    const [hoists]  = hoistRows
    const [byStore] = byStoreRows

    const hoistBreakdown = hoists.map((r: any) => {
      const jobCount       = Number(r.job_count)
      const utilisationPct = Math.min(100, Math.round((jobCount / slotsPerHoist) * 100))
      return { hoistId: Number(r.hoist_id), label: r.label, utilisationPct, jobCount }
    })

    const utilisation = hoistBreakdown.length > 0
      ? Math.round(hoistBreakdown.reduce((s: number, h: any) => s + h.utilisationPct, 0) / hoistBreakdown.length)
      : 0

    const result: any = { period, store: scope.label, utilisation, hoistBreakdown }

    if (scope.isAll) {
      // Group byStore rows by store
      const storeMap = new Map<string, number[]>()
      for (const r of byStore) {
        const name = r.store_name.replace(/^Rodz /, '')
        if (!storeMap.has(name)) storeMap.set(name, [])
        const jobCount = Number(r.job_count)
        storeMap.get(name)!.push(Math.min(100, Math.round((jobCount / slotsPerHoist) * 100)))
      }
      result.byStore = Array.from(storeMap.entries()).map(([store, pcts]) => ({
        store,
        utilisation: Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length),
      }))
    }

    return ok(result)
  } catch (err) {
    return serverError(err)
  }
}
