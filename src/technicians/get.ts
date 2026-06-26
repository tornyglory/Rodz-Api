import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, serverError } from '../shared/errors'
import { getAllowedStoreIds, buildJob, getJobServices } from '../jobs/_helpers'
import { getPeriodRange, countWorkingDays, fetchStats } from './_helpers'

const ready = bootstrap()

// All non-cancelled jobs for this tech in period. Includes in_progress, open, etc.
// amount = invoice total → quote total → 0
const TECH_JOBS_SELECT = `
  SELECT
    j.id, j.job_number, j.booking_id, j.store_id, j.hoist_id, j.customer_id, j.vehicle_id,
    j.status, j.slot, j.scheduled_time, j.sort_order, j.customer_notes, j.odometer_in,
    j.started_at, j.completed_at,
    COALESCE(j.quote_id, bq.id) AS quote_id,
    COALESCE(jq.status, bq.status) AS quote_status,
    b.booking_date AS job_date, b.booking_ref,
    CONCAT(c.first_name, ' ', c.last_name)                            AS customer_name,
    c.email                                                            AS customer_email,
    CONCAT(v.year, ' ', v.make, ' ', v.model)                         AS vehicle_label,
    v.rego                                                             AS vehicle_rego,
    h.name                                                             AS hoist_name,
    s.name                                                             AS store_name,
    sjs.staff_id                                                       AS assigned_staff_id,
    CONCAT(st_tech.first_name, ' ', LEFT(st_tech.last_name, 1), '.')  AS tech_label,
    COALESCE(
      j.duration_mins,
      (SELECT SUM(svc.labour_hours_estimate * 60)
       FROM booking_services bs_d
       JOIN service_types svc ON svc.id = bs_d.service_type_id
       WHERE bs_d.booking_id = j.booking_id),
      60
    ) AS duration_mins,
    COALESCE(inv.total, jq.total, bq.total, 0) AS amount
  FROM service_jobs j
  JOIN bookings b    ON b.id  = j.booking_id
  JOIN customers c   ON c.id  = j.customer_id
  JOIN stores s      ON s.id  = j.store_id
  JOIN hoists h      ON h.id  = j.hoist_id
  LEFT JOIN vehicles v ON v.id = j.vehicle_id
  JOIN service_job_staff sjs
       ON sjs.service_job_id = j.id
       AND sjs.role_on_job = 'lead_mechanic'
       AND sjs.staff_id = ?
  LEFT JOIN staff st_tech ON st_tech.id = sjs.staff_id
  LEFT JOIN invoices inv ON inv.job_id = j.id
  LEFT JOIN quotes bq ON bq.booking_id = j.booking_id AND bq.id = (
    SELECT MAX(q2.id) FROM quotes q2 WHERE q2.booking_id = j.booking_id
  )
  LEFT JOIN quotes jq ON jq.id = j.quote_id`

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id
  const qs = event.queryStringParameters ?? {}

  const period = (qs.period ?? 'week') as 'week' | 'month' | 'year'
  const page   = Math.max(1, parseInt(qs.page  ?? '1',  10) || 1)
  const limit  = Math.min(100, Math.max(1, parseInt(qs.limit ?? '20', 10) || 20))
  const offset = (page - 1) * limit

  try {
    // ── Auth: technician can only view own record ──────────────────────────
    if (ctx.role === 'technician' && String(ctx.staffId) !== String(id)) {
      return forbidden()
    }

    // ── Verify tech exists and caller has store access ─────────────────────
    const [[techRow]] = await db.query<any[]>(
      'SELECT id, store_id FROM staff WHERE id = ? AND is_active = 1 LIMIT 1',
      [id],
    )
    if (!techRow) return notFound('Technician not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(techRow.store_id)) return forbidden()
    }

    // ── Period date range ──────────────────────────────────────────────────
    const { start, end } = getPeriodRange(period)
    const wDays = countWorkingDays(start, end)

    // ── Count: all non-cancelled jobs in period ────────────────────────────
    const [[{ total }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS total
       FROM service_jobs j
       JOIN bookings b ON b.id = j.booking_id
       JOIN service_job_staff sjs
            ON sjs.service_job_id = j.id
            AND sjs.role_on_job = 'lead_mechanic'
            AND sjs.staff_id = ?
       WHERE b.booking_date BETWEEN ? AND ?
         AND j.status != 'cancelled'`,
      [id, start, end],
    )

    // ── Jobs page ──────────────────────────────────────────────────────────
    const [jobRows] = await db.query<any[]>(
      `${TECH_JOBS_SELECT}
       WHERE b.booking_date BETWEEN ? AND ?
         AND j.status != 'cancelled'
       ORDER BY b.booking_date DESC, j.id DESC
       LIMIT ? OFFSET ?`,
      [id, start, end, limit, offset],
    )

    const jobIds = jobRows.map((r: any) => r.id as number)
    const svcMap = await getJobServices(db, jobIds)
    const jobs   = jobRows.map((r: any) => ({
      ...buildJob(r, svcMap.get(r.id) ?? []),
      amount: Math.round(Number(r.amount)) || 0,
    }))

    // ── Period totals (all 3 periods share same fetchStats logic) ──────────
    const statsMap     = await fetchStats(db, [Number(id)], start, end, wDays)
    const zero         = { jobsCompleted: 0, hoursBilled: 0, revenue: 0, efficiency: 0 }
    const periodTotals = statsMap.get(Number(id)) ?? zero

    return ok({
      techId: Number(id),
      period,
      jobs,
      pagination: {
        page,
        limit,
        total: Number(total),
        pages: Math.ceil(Number(total) / limit),
      },
      periodTotals,
    })
  } catch (err) {
    return serverError(err)
  }
}
