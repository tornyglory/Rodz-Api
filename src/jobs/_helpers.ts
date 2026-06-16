import mysql from 'mysql2/promise'

export const JOB_FROM = `
  FROM service_jobs j
  JOIN bookings b    ON b.id  = j.booking_id
  JOIN customers c   ON c.id  = j.customer_id
  JOIN stores s      ON s.id  = j.store_id
  JOIN hoists h      ON h.id  = j.hoist_id
  LEFT JOIN vehicles v        ON v.id  = j.vehicle_id
  LEFT JOIN service_job_staff sjs     ON sjs.service_job_id = j.id AND sjs.role_on_job = 'lead_mechanic'
  LEFT JOIN staff st_tech             ON st_tech.id = sjs.staff_id
  LEFT JOIN quotes bq ON bq.booking_id = j.booking_id AND bq.id = (
    SELECT MAX(q2.id) FROM quotes q2 WHERE q2.booking_id = j.booking_id
  )
  LEFT JOIN quotes jq ON jq.id = j.quote_id`

export const JOB_SELECT = `
  SELECT
    j.id, j.job_number, j.booking_id, j.store_id, j.hoist_id, j.customer_id, j.vehicle_id,
    j.status, j.slot, j.scheduled_time, j.sort_order, j.customer_notes, j.odometer_in,
    j.started_at, j.completed_at,
    COALESCE(j.quote_id, bq.id) AS quote_id,
    COALESCE(jq.status, bq.status) AS quote_status,
    b.booking_date AS job_date, b.booking_ref,
    CONCAT(c.first_name, ' ', c.last_name)     AS customer_name,
    c.email                                    AS customer_email,
    CONCAT(v.year, ' ', v.make, ' ', v.model)  AS vehicle_label,
    v.rego                                     AS vehicle_rego,
    h.name                                     AS hoist_name,
    s.name                                     AS store_name,
    sjs.staff_id                               AS assigned_staff_id,
    CONCAT(st_tech.first_name, ' ', LEFT(st_tech.last_name, 1), '.') AS tech_label,
    COALESCE(
      j.duration_mins,
      (SELECT SUM(svc.labour_hours_estimate * 60)
       FROM booking_services bs_d
       JOIN service_types svc ON svc.id = bs_d.service_type_id
       WHERE bs_d.booking_id = j.booking_id),
      60
    ) AS duration_mins
  ${JOB_FROM}`

export const JOB_SELECT_BY_ID = `${JOB_SELECT} WHERE j.id = ? LIMIT 1`

export function buildJob(row: any, services: any[]) {
  const toTime = (t: any) => {
    if (!t) return null
    const s = String(t)
    if (s === '00:00:00' || s === '00:00') return null
    if (s.includes(':') && s.length <= 8) return s.slice(0, 5)
    return null
  }

  const toDate = (d: any) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)

  return {
    id:              row.id,
    jobNumber:       row.job_number,
    bookingId:       row.booking_id,
    customerId:      row.customer_id,
    vehicleId:       row.vehicle_id,
    bookingRef:      row.booking_ref ?? null,
    customer:        row.customer_name,
    customerEmail:   row.customer_email ?? null,
    vehicle:         row.vehicle_label ?? null,
    rego:            row.vehicle_rego ?? null,
    service:         services.map((s) => s.name).join(', ') || null,
    services:        services.map((s) => ({
      serviceTypeId:       s.service_type_id,
      name:                s.name,
      category:            s.category,
      customerDescription: s.customer_description ?? null,
    })),
    hoist:           row.hoist_name,
    hoistId:         row.hoist_id,
    status:          row.status,
    tech:            row.tech_label ?? 'Unassigned',
    assignedStaffId: row.assigned_staff_id ?? null,
    store:           (row.store_name ?? '').replace(/^Rodz /, ''),
    date:            toDate(row.job_date),
    slot:            row.slot,
    startTime:       toTime(row.scheduled_time),
    durationMins:    Number(row.duration_mins) || 60,
    sortOrder:       row.sort_order,
    notes:           row.customer_notes ?? null,
    quoteId:         row.quote_id ?? null,
    quoteStatus:     row.quote_status ?? null,
    odometerIn:      row.odometer_in ?? null,
    startedAt:       row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt:     row.completed_at ? new Date(row.completed_at).toISOString() : null,
  }
}

export function jobError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}

export async function getJobServices(
  db: mysql.Pool,
  jobIds: number[],
): Promise<Map<number, any[]>> {
  if (jobIds.length === 0) return new Map()
  const placeholders = jobIds.map(() => '?').join(',')
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    `SELECT j.id AS job_id, bs.service_type_id, st.name, st.category, bs.customer_description
     FROM service_jobs j
     JOIN booking_services bs ON bs.booking_id = j.booking_id
     JOIN service_types st    ON st.id = bs.service_type_id
     WHERE j.id IN (${placeholders})
     ORDER BY j.id, bs.service_type_id`,
    jobIds,
  )
  const map = new Map<number, any[]>()
  for (const row of rows) {
    if (!map.has(row.job_id)) map.set(row.job_id, [])
    map.get(row.job_id)!.push(row)
  }
  return map
}

export async function getAllowedStoreIds(db: mysql.Pool, staffId: string): Promise<number[]> {
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    'SELECT store_id FROM staff_store_access WHERE staff_id = ? AND revoked_at IS NULL',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}

export async function generateJobNumber(db: mysql.Pool): Promise<string> {
  const [[{ nextNum }]] = await db.query<any[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(job_number, 2) AS UNSIGNED)), 0) + 1 AS nextNum
     FROM service_jobs`,
  )
  return `J${String(nextNum).padStart(5, '0')}`
}
