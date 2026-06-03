import mysql from 'mysql2/promise'

function formatDate(d: Date | string | null): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

export async function buildCustomerList(db: mysql.Pool, rows: any[]) {
  if (rows.length === 0) return []

  const ids = rows.map((r: any) => r.id)

  const [[tagRows], [vehicleRows], [statsRows]] = await Promise.all([
    db.query<any[]>('SELECT customer_id, tag FROM customer_tags WHERE customer_id IN (?)', [ids]),
    db.query<any[]>(
      `SELECT vo.customer_id, v.id, v.rego, v.year, v.make, v.model
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       WHERE vo.customer_id IN (?) AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [ids],
    ),
    db.query<any[]>(
      `SELECT
         sj.customer_id,
         COUNT(DISTINCT sj.id)            AS totalVisits,
         COALESCE(SUM(sji.line_total), 0) AS totalSpend,
         MAX(sj.completed_at)             AS lastVisit
       FROM service_jobs sj
       LEFT JOIN service_job_items sji ON sji.service_job_id = sj.id
       WHERE sj.customer_id IN (?) AND sj.status IN ('completed', 'invoiced')
       GROUP BY sj.customer_id`,
      [ids],
    ),
  ])

  const tagsMap = new Map<number, string[]>()
  for (const r of tagRows) {
    if (!tagsMap.has(r.customer_id)) tagsMap.set(r.customer_id, [])
    tagsMap.get(r.customer_id)!.push(r.tag)
  }

  const vehiclesMap = new Map<number, any[]>()
  for (const r of vehicleRows) {
    if (!vehiclesMap.has(r.customer_id)) vehiclesMap.set(r.customer_id, [])
    vehiclesMap.get(r.customer_id)!.push({ id: r.id, rego: r.rego, year: r.year, make: r.make, model: r.model })
  }

  const statsMap = new Map<number, any>()
  for (const r of statsRows) statsMap.set(r.customer_id, r)

  return rows.map((row: any) => {
    const stats = statsMap.get(row.id)
    return {
      id:          row.id,
      name:        `${row.first_name} ${row.last_name}`.trim(),
      email:       row.email,
      phone:       row.mobile,
      store:       row.store_name,
      tags:        tagsMap.get(row.id) ?? [],
      totalVisits: stats ? Number(stats.totalVisits) : 0,
      totalSpend:  stats ? Number(Number(stats.totalSpend).toFixed(2)) : 0,
      lastVisit:   stats?.lastVisit ? formatDate(stats.lastVisit) : null,
      notes:       row.internal_notes ?? null,
      vehicles:    vehiclesMap.get(row.id) ?? [],
      jobHistory:  [],
    }
  })
}

export async function buildCustomerFull(db: mysql.Pool, row: any) {
  const [tags, vehicles, stats, jobs] = await Promise.all([
    db.query<any[]>('SELECT tag FROM customer_tags WHERE customer_id = ?', [row.id]),
    db.query<any[]>(
      `SELECT v.id, v.rego, v.year, v.make, v.model
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT
         COUNT(DISTINCT sj.id)            AS totalVisits,
         COALESCE(SUM(sji.line_total), 0) AS totalSpend,
         MAX(sj.completed_at)             AS lastVisit
       FROM service_jobs sj
       LEFT JOIN service_job_items sji ON sji.service_job_id = sj.id
       WHERE sj.customer_id = ? AND sj.status IN ('completed', 'invoiced')`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT
         sj.id,
         sj.completed_at,
         sj.status,
         sj.odometer_in                             AS km,
         v.make, v.model, v.rego,
         st.name                                    AS store_name,
         COALESCE(tot.amount, 0)                    AS amount,
         COALESCE(desc_.service, '')                AS service,
         CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS tech
       FROM service_jobs sj
       JOIN  vehicles v   ON v.id   = sj.vehicle_id
       JOIN  stores   st  ON st.id  = sj.store_id
       LEFT JOIN (
         SELECT service_job_id, SUM(line_total) AS amount
         FROM service_job_items GROUP BY service_job_id
       ) tot ON tot.service_job_id = sj.id
       LEFT JOIN (
         SELECT service_job_id,
                GROUP_CONCAT(description ORDER BY sort_order SEPARATOR ', ') AS service
         FROM service_job_items WHERE line_type = 'labour'
         GROUP BY service_job_id
       ) desc_ ON desc_.service_job_id = sj.id
       LEFT JOIN service_job_staff sjs ON sjs.service_job_id = sj.id AND sjs.role_on_job = 'lead_mechanic'
       LEFT JOIN staff s ON s.id = sjs.staff_id
       WHERE sj.customer_id = ?
       ORDER BY COALESCE(sj.completed_at, sj.created_at) DESC`,
      [row.id],
    ),
  ])

  const [[tagRows], [vehicleRows], [[statsRow]], [jobRows]] = [tags, vehicles, stats, jobs]

  return {
    id:          row.id,
    name:        `${row.first_name} ${row.last_name}`.trim(),
    email:       row.email,
    phone:       row.mobile,
    store:       row.store_name,
    tags:        tagRows.map((t: any) => t.tag),
    totalVisits: Number(statsRow.totalVisits),
    totalSpend:  Number(Number(statsRow.totalSpend).toFixed(2)),
    lastVisit:   statsRow.lastVisit ? formatDate(statsRow.lastVisit) : null,
    notes:       row.internal_notes ?? null,
    vehicles:    vehicleRows.map((v: any) => ({ id: v.id, rego: v.rego, year: v.year, make: v.make, model: v.model })),
    jobHistory:  jobRows.map((j: any) => ({
      id:      j.id,
      date:    j.completed_at ? formatDate(j.completed_at) : null,
      service: j.service || null,
      vehicle: `${j.make} ${j.model} (${j.rego})`,
      amount:  Number(Number(j.amount).toFixed(2)),
      store:   j.store_name,
      status:  j.status,
      tech:    j.tech ?? null,
      km:      j.km ?? null,
    })),
  }
}
