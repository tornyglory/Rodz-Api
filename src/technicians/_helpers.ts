import mysql from 'mysql2/promise'

export function getPeriodRange(period: 'week' | 'month' | 'year'): { start: string; end: string } {
  // AEST approximation (UTC+10); close enough for date-boundary decisions
  const now = new Date(Date.now() + 10 * 60 * 60 * 1000)
  const today = now.toISOString().slice(0, 10)
  const t = new Date(today)

  let startDate: Date
  if (period === 'week') {
    const dow = t.getUTCDay() // 0=Sun
    const diff = dow === 0 ? 6 : dow - 1 // days back to Monday
    startDate = new Date(t)
    startDate.setUTCDate(t.getUTCDate() - diff)
  } else if (period === 'month') {
    startDate = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))
  } else {
    startDate = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  }

  return { start: startDate.toISOString().slice(0, 10), end: today }
}

export function countWorkingDays(startStr: string, endStr: string): number {
  let count = 0
  const cur = new Date(startStr)
  const end = new Date(endStr)
  while (cur <= end) {
    const d = cur.getUTCDay()
    if (d !== 0 && d !== 6) count++
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return Math.max(count, 1)
}

export function calcEfficiency(hoursBilled: number, workingDays: number): number {
  if (workingDays <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((hoursBilled / (workingDays * 8)) * 100)))
}

export interface TechStats {
  jobsCompleted: number
  hoursBilled: number
  revenue: number
  efficiency: number
}

export async function fetchStats(
  db: mysql.Pool,
  staffIds: number[],
  start: string,
  end: string,
  workingDays: number,
): Promise<Map<number, TechStats>> {
  if (staffIds.length === 0) return new Map()
  const ph = staffIds.map(() => '?').join(',')

  // hoursBilled = duration of ALL non-cancelled jobs in the period (booked date, not completed date)
  // jobsCompleted / revenue = completed jobs only
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    `SELECT
       sjs.staff_id,
       COUNT(DISTINCT CASE WHEN job_data.status = 'completed' THEN job_data.id END)              AS jobs_completed,
       COALESCE(ROUND(SUM(job_data.duration_mins / 60.0), 1), 0)                                  AS hours_billed,
       COALESCE(SUM(CASE WHEN job_data.status = 'completed' THEN job_data.revenue ELSE 0 END), 0) AS revenue
     FROM service_job_staff sjs
     JOIN (
       SELECT
         j.id,
         j.status,
         COALESCE(j.duration_mins, dur.mins, 60) AS duration_mins,
         COALESCE(inv.total, q.total, 0)          AS revenue
       FROM service_jobs j
       JOIN bookings b ON b.id = j.booking_id
       LEFT JOIN (
         SELECT bs.booking_id, SUM(svc.labour_hours_estimate * 60) AS mins
         FROM booking_services bs
         JOIN service_types svc ON svc.id = bs.service_type_id
         GROUP BY bs.booking_id
       ) dur ON dur.booking_id = j.booking_id
       LEFT JOIN invoices inv ON inv.job_id = j.id
       LEFT JOIN quotes q ON q.id = COALESCE(
         j.quote_id,
         (SELECT MAX(q2.id) FROM quotes q2 WHERE q2.booking_id = j.booking_id)
       )
       WHERE b.booking_date BETWEEN ? AND ?
         AND j.status != 'cancelled'
     ) job_data ON job_data.id = sjs.service_job_id
     WHERE sjs.role_on_job = 'lead_mechanic'
       AND sjs.staff_id IN (${ph})
     GROUP BY sjs.staff_id`,
    [start, end, ...staffIds],
  )

  const map = new Map<number, TechStats>()
  for (const r of rows) {
    const hours = parseFloat(Number(r.hours_billed).toFixed(1))
    map.set(Number(r.staff_id), {
      jobsCompleted: Number(r.jobs_completed),
      hoursBilled:   hours,
      revenue:       Math.round(Number(r.revenue)),
      efficiency:    calcEfficiency(hours, workingDays),
    })
  }
  return map
}
