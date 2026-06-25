import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

function melbDateToday(): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const v = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${v('year')}-${v('month')}-${v('day')}`
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const qs  = event.queryStringParameters ?? {}

  // Optional date param — defaults to Melbourne today. Format: YYYY-MM-DD
  const date     = qs.date ?? melbDateToday()
  const prevDate = new Date(date + 'T00:00:00')
  prevDate.setDate(prevDate.getDate() - 1)
  const yesterday = prevDate.toISOString().slice(0, 10)

  try {
    // ── Store scope ──────────────────────────────────────────────────────────
    let storeFilter     = ''
    let sjStoreFilter   = ''   // qualified for multi-join completedJobs query
    let storeParams: any[] = []

    if (ctx.role === 'super_admin') {
      if (qs.storeId) {
        storeFilter   = 'AND store_id = ?'
        sjStoreFilter = 'AND sj.store_id = ?'
        storeParams   = [Number(qs.storeId)]
      }
      // No storeId = all stores
    } else {
      // Non-super_admin: always scope to their own store
      const myStoreId = ctx.storeId
      if (!myStoreId) return ok(emptyResponse(date))
      storeFilter   = 'AND store_id = ?'
      sjStoreFilter = 'AND sj.store_id = ?'
      storeParams   = [myStoreId]
    }

    const [
      // Pending bookings today + yesterday
      [[{ pendingToday }]],
      [[{ pendingYesterday }]],
      // Revenue today + yesterday
      [[{ revenueToday }]],
      [[{ revenueYesterday }]],
      // Hoists
      [[{ totalHoists }]],
      [[{ hoistsInUse }]],
      // Jobs completed today + yesterday
      [[{ completedToday }]],
      [[{ completedYesterday }]],
      // Booking queue counts for date
      [[{ queuePending }]],
      [[{ queueConfirmed }]],
      [[{ queueRejected }]],
      // Completed jobs list
      [completedJobs],
    ] = await Promise.all([
      db.query<any[]>(
        `SELECT COUNT(*) AS pendingToday FROM bookings
         WHERE booking_date = ? AND status = 'pending' AND cancelled_at IS NULL ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS pendingYesterday FROM bookings
         WHERE booking_date = ? AND status = 'pending' AND cancelled_at IS NULL ${storeFilter}`,
        [yesterday, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COALESCE(SUM(total), 0) AS revenueToday FROM invoices
         WHERE status = 'paid'
           AND DATE(CONVERT_TZ(paid_at, '+00:00', 'Australia/Melbourne')) = ? ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COALESCE(SUM(total), 0) AS revenueYesterday FROM invoices
         WHERE status = 'paid'
           AND DATE(CONVERT_TZ(paid_at, '+00:00', 'Australia/Melbourne')) = ? ${storeFilter}`,
        [yesterday, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS totalHoists FROM hoists
         WHERE is_active = 1 ${storeFilter}`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COUNT(DISTINCT hoist_id) AS hoistsInUse FROM service_jobs
         WHERE hoist_id IS NOT NULL AND status = 'in_progress' ${storeFilter}`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS completedToday FROM service_jobs
         WHERE DATE(completed_at) = ? AND status = 'completed' ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS completedYesterday FROM service_jobs
         WHERE DATE(completed_at) = ? AND status = 'completed' ${storeFilter}`,
        [yesterday, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS queuePending FROM bookings
         WHERE booking_date = ? AND status = 'pending' AND cancelled_at IS NULL ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS queueConfirmed FROM bookings
         WHERE booking_date = ? AND status = 'confirmed' AND cancelled_at IS NULL ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS queueRejected FROM bookings
         WHERE booking_date = ? AND status = 'rejected' ${storeFilter}`,
        [date, ...storeParams],
      ),
      db.query<any[]>(
        `SELECT
           sj.id          AS jobId,
           s.name         AS store,
           CONCAT(c.first_name, ' ', c.last_name) AS customerName,
           v.rego,
           CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicleLabel,
           GROUP_CONCAT(DISTINCT svt.name ORDER BY bs.sort_order SEPARATOR ', ') AS services,
           CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech,
           sj.completed_at AS completedAt
         FROM service_jobs sj
         JOIN stores   s ON s.id = sj.store_id
         JOIN customers c ON c.id = sj.customer_id
         JOIN vehicles  v ON v.id = sj.vehicle_id
         LEFT JOIN bookings          b   ON b.id   = sj.booking_id
         LEFT JOIN booking_services  bs  ON bs.booking_id = b.id
         LEFT JOIN service_types     svt ON svt.id = bs.service_type_id
         LEFT JOIN service_job_staff sjs ON sjs.service_job_id = sj.id AND sjs.role_on_job = 'lead_mechanic'
         LEFT JOIN staff             st  ON st.id  = sjs.staff_id
         WHERE DATE(sj.completed_at) = ? AND sj.status = 'completed' ${sjStoreFilter}
         GROUP BY sj.id, s.name, c.first_name, c.last_name, v.rego, v.year, v.make, v.model, st.first_name, st.last_name, sj.completed_at
         ORDER BY sj.completed_at DESC`,
        [date, ...storeParams],
      ),
    ])

    const totalH    = Number(totalHoists)
    const inUseH    = Number(hoistsInUse)
    const revToday  = Number(Number(revenueToday).toFixed(2))
    const revYest   = Number(Number(revenueYesterday).toFixed(2))

    return ok({
      date,
      stats: {
        pendingBookings: {
          value: Number(pendingToday),
          delta: Number(pendingToday) - Number(pendingYesterday),
        },
        todayRevenue: {
          value: revToday,
          delta: Number((revToday - revYest).toFixed(2)),
        },
        hoists: {
          active:    inUseH,
          total:     totalH,
          available: totalH - inUseH,
        },
        jobsCompleted: {
          value: Number(completedToday),
          delta: Number(completedToday) - Number(completedYesterday),
        },
      },
      bookingQueue: {
        pending:   Number(queuePending),
        confirmed: Number(queueConfirmed),
        rejected:  Number(queueRejected),
      },
      completedJobs: completedJobs.map((r: any) => ({
        jobId:        r.jobId,
        store:        r.store,
        customerName: r.customerName,
        rego:         r.rego,
        vehicleLabel: r.vehicleLabel,
        services:     r.services ?? null,
        tech:         r.tech     ?? null,
        completedAt:  r.completedAt instanceof Date
          ? r.completedAt.toISOString()
          : String(r.completedAt),
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}

function emptyResponse(date: string) {
  return {
    date,
    stats: {
      pendingBookings: { value: 0, delta: 0 },
      todayRevenue:    { value: 0, delta: 0 },
      hoists:          { active: 0, total: 0, available: 0 },
      jobsCompleted:   { value: 0, delta: 0 },
    },
    bookingQueue:  { pending: 0, confirmed: 0, rejected: 0 },
    completedJobs: [],
  }
}
