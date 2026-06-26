import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { getAllowedStoreIds } from '../jobs/_helpers'

const ready = bootstrap()

const JOBS_PER_HOIST = 4

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const qs  = event.queryStringParameters ?? {}

  // Default to Melbourne today (UTC+10 approximation)
  const melbourneNow = new Date(Date.now() + 10 * 60 * 60 * 1000)
  const date = qs.date ?? melbourneNow.toISOString().slice(0, 10)

  try {
    // Determine which stores this caller can see
    let storeFilter = ''
    const params: unknown[] = [date]

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ date, stores: [] })
      storeFilter = `AND s.id IN (${allowedIds.map(() => '?').join(',')})`
      params.push(...allowedIds)
    }

    // Per-hoist detail: one row per active hoist
    const [hoistRows] = await db.query<any[]>(
      `SELECT
         s.id                                                              AS store_id,
         REPLACE(s.name, 'Rodz ', '')                                     AS store_name,
         h.id                                                              AS hoist_id,
         h.name                                                            AS hoist_name,
         h.assigned_staff_id IS NOT NULL                                   AS operational,
         CONCAT(st.first_name, ' ', LEFT(st.last_name, 1), '.')           AS tech_label,
         COALESCE(jstat.booked_jobs, 0)                                    AS booked_jobs
       FROM stores s
       JOIN hoists h ON h.store_id = s.id AND h.is_active = 1
       LEFT JOIN staff st ON st.id = h.assigned_staff_id
       LEFT JOIN (
         SELECT j.hoist_id, COUNT(*) AS booked_jobs
         FROM service_jobs j
         JOIN bookings b ON b.id = j.booking_id
         WHERE b.booking_date = ?
           AND j.status != 'cancelled'
         GROUP BY j.hoist_id
       ) jstat ON jstat.hoist_id = h.id
       WHERE s.is_active = 1 ${storeFilter}
       ORDER BY s.id, h.id`,
      params,
    )

    // Group by store
    const storeMap = new Map<number, {
      storeId: number
      store: string
      hoists: any[]
    }>()

    for (const r of hoistRows) {
      const sid = Number(r.store_id)
      if (!storeMap.has(sid)) {
        storeMap.set(sid, { storeId: sid, store: r.store_name, hoists: [] })
      }
      storeMap.get(sid)!.hoists.push({
        id:             Number(r.hoist_id),
        label:          r.hoist_name,
        operational:    Boolean(r.operational),
        assignedTech:   r.tech_label ?? null,
        bookedJobs:     Number(r.booked_jobs),
        maxJobs:        JOBS_PER_HOIST,
        availableSlots: r.operational ? Math.max(0, JOBS_PER_HOIST - Number(r.booked_jobs)) : 0,
      })
    }

    const stores = Array.from(storeMap.values()).map(({ storeId, store, hoists }) => {
      const operationalHoists = hoists.filter(h => h.operational).length
      const maxCapacity       = operationalHoists * JOBS_PER_HOIST
      const bookedJobs        = hoists.reduce((sum, h) => sum + h.bookedJobs, 0)
      const availableSlots    = Math.max(0, maxCapacity - bookedJobs)

      return {
        storeId,
        store,
        operationalHoists,
        totalHoists:    hoists.length,
        maxCapacity,
        bookedJobs,
        availableSlots,
        utilizationPct: maxCapacity > 0 ? Math.round((bookedJobs / maxCapacity) * 100) : 0,
        hoists,
      }
    })

    return ok({ date, stores })
  } catch (err) {
    return serverError(err)
  }
}
