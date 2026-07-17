import mysql from 'mysql2/promise'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatDate(d: Date | string | null): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatJoined(d: Date | string | null): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

export async function buildCustomerList(db: mysql.Pool, rows: any[]) {
  if (rows.length === 0) return []

  const ids = rows.map((r: any) => r.id)

  const [[tagRows], [vehicleRows], [statsRows], [spendRows]] = await Promise.all([
    db.query<any[]>('SELECT customer_id, tag FROM customer_tags WHERE customer_id IN (?)', [ids]),
    db.query<any[]>(
      `SELECT vo.customer_id, v.id, v.rego, v.year, v.make, v.model,
              (
                SELECT NULLIF(GREATEST(
                  COALESCE(MAX(sj.odometer_in), 0),
                  COALESCE(MAX(sj.odometer_out), 0)
                ), 0)
                FROM service_jobs sj WHERE sj.vehicle_id = v.id
              ) AS odometer
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       WHERE vo.customer_id IN (?) AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [ids],
    ),
    db.query<any[]>(
      `SELECT
         sj.customer_id,
         COUNT(DISTINCT sj.id)                          AS totalVisits,
         MAX(COALESCE(sj.completed_at, sj.updated_at)) AS lastVisit
       FROM service_jobs sj
       WHERE sj.customer_id IN (?) AND sj.status IN ('completed', 'invoiced')
       GROUP BY sj.customer_id`,
      [ids],
    ),
    db.query<any[]>(
      `SELECT customer_id, COALESCE(SUM(total), 0) AS totalSpend
       FROM invoices
       WHERE customer_id IN (?) AND status IN ('sent', 'paid')
       GROUP BY customer_id`,
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
    vehiclesMap.get(r.customer_id)!.push({ id: r.id, rego: r.rego, year: r.year, make: r.make, model: r.model, odometer: r.odometer != null ? Number(r.odometer) : null })
  }

  const statsMap = new Map<number, any>()
  for (const r of statsRows) statsMap.set(r.customer_id, r)

  const spendMap = new Map<number, number>()
  for (const r of spendRows) spendMap.set(r.customer_id, Number(Number(r.totalSpend).toFixed(2)))

  return rows.map((row: any) => {
    const stats = statsMap.get(row.id)
    return {
      id:            row.id,
      name:          `${row.first_name} ${row.last_name}`.trim(),
      email:         row.email,
      phone:         row.mobile,
      store:         row.store_name,
      tier:          (row.tier ?? 'free') as 'free' | 'silver' | 'gold',
      isPremium:     (row.tier ?? 'free') !== 'free',
      avatarImageId: row.avatar_image_id ?? null,
      tags:         tagsMap.get(row.id) ?? [],
      totalVisits:  stats ? Number(stats.totalVisits) : 0,
      totalSpend:   spendMap.get(row.id) ?? 0,
      lastVisit:    stats?.lastVisit ? formatDate(stats.lastVisit) : null,
      memberSince:  row.created_at ? formatDate(row.created_at) : null,
      joined:       formatJoined(row.created_at),
      notes:        row.internal_notes ?? null,
      dob:         row.date_of_birth ? (row.date_of_birth instanceof Date ? row.date_of_birth.toISOString().slice(0, 10) : String(row.date_of_birth).slice(0, 10)) : null,
      address: {
        line1:    row.address_line1 ?? null,
        line2:    row.address_line2 ?? null,
        suburb:   row.suburb ?? null,
        state:    row.state ?? null,
        postcode: row.postcode ?? null,
      },
      vehicles:    vehiclesMap.get(row.id) ?? [],
      jobHistory:  [],
    }
  })
}

const NOTIFICATION_TOPIC_COLUMNS = [
  'service_due',
  'rego_expiring',
  'booking',
  'quote',
  'invoice',
  'urgent_reco',
  'workshop_message',
] as const

const TOPIC_COLUMN_TO_KEY: Record<(typeof NOTIFICATION_TOPIC_COLUMNS)[number], string> = {
  service_due:      'serviceDue',
  rego_expiring:    'regoExpiring',
  booking:          'booking',
  quote:            'quote',
  invoice:          'invoice',
  urgent_reco:      'urgentReco',
  workshop_message: 'workshopMessage',
}

function timeToHhMm(v: unknown): string | null {
  if (!v) return null
  // mysql2 returns TIME as "HH:MM:SS" string. TRIM to "HH:MM" per project convention.
  return String(v).slice(0, 5)
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export async function buildCustomerFull(db: mysql.Pool, row: any) {
  const [tags, vehicles, stats, spend, jobs, notesCountRes, pushDevicesRes, notifPrefsRes] = await Promise.all([
    db.query<any[]>('SELECT tag FROM customer_tags WHERE customer_id = ?', [row.id]),
    db.query<any[]>(
      `SELECT v.id, v.rego, v.year, v.make, v.model, v.avatar_image_id, v.cover_image_id,
              (
                SELECT NULLIF(GREATEST(
                  COALESCE(MAX(sj.odometer_in), 0),
                  COALESCE(MAX(sj.odometer_out), 0)
                ), 0)
                FROM service_jobs sj WHERE sj.vehicle_id = v.id
              ) AS odometer,
              (SELECT COUNT(*) FROM vehicle_notes WHERE vehicle_id = v.id) AS notes_count
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT
         COUNT(DISTINCT sj.id)                          AS totalVisits,
         MAX(COALESCE(sj.completed_at, sj.updated_at)) AS lastVisit
       FROM service_jobs sj
       WHERE sj.customer_id = ? AND sj.status IN ('completed', 'invoiced')`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT COALESCE(SUM(total), 0) AS totalSpend
       FROM invoices
       WHERE customer_id = ? AND status IN ('sent', 'paid')`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT
         sj.id,
         sj.completed_at,
         sj.status,
         sj.odometer_in                             AS km,
         sj.next_service_due_km,
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
    db.query<any[]>(
      'SELECT COUNT(*) AS count FROM customer_notes WHERE customer_id = ?',
      [row.id],
    ),
    db.query<any[]>(
      `SELECT COUNT(*) AS device_count, MAX(last_seen_at) AS last_seen
         FROM customer_push_tokens
        WHERE customer_id = ?`,
      [row.id],
    ),
    db.query<any[]>(
      `SELECT service_due, rego_expiring, booking, quote, invoice,
              urgent_reco, workshop_message,
              quiet_hours_start, quiet_hours_end
         FROM customer_notification_prefs
        WHERE customer_id = ?
        LIMIT 1`,
      [row.id],
    ),
  ])

  const [[tagRows], [vehicleRows], [[statsRow]], [[spendRow]], [jobRows], [[notesRow]], [[pushRow]], [[prefsRow]]] =
    [tags, vehicles, stats, spend, jobs, notesCountRes, pushDevicesRes, notifPrefsRes]

  const topicsOptedOut: string[] = []
  if (prefsRow) {
    for (const col of NOTIFICATION_TOPIC_COLUMNS) {
      if (Number(prefsRow[col]) === 0) topicsOptedOut.push(TOPIC_COLUMN_TO_KEY[col])
    }
  }

  const quietStart = timeToHhMm(prefsRow?.quiet_hours_start)
  const quietEnd   = timeToHhMm(prefsRow?.quiet_hours_end)

  return {
    id:            row.id,
    name:          `${row.first_name} ${row.last_name}`.trim(),
    email:         row.email,
    phone:         row.mobile,
    store:         row.store_name,
    tier:          (row.tier ?? 'free') as 'free' | 'silver' | 'gold',
    isPremium:     (row.tier ?? 'free') !== 'free',
    avatarImageId: row.avatar_image_id ?? null,
    tags:        tagRows.map((t: any) => t.tag),
    totalVisits: Number(statsRow.totalVisits),
    totalSpend:  Number(Number(spendRow?.totalSpend ?? 0).toFixed(2)),
    lastVisit:   statsRow.lastVisit ? formatDate(statsRow.lastVisit) : null,
    memberSince: row.created_at ? formatDate(row.created_at) : null,
    joined:      formatJoined(row.created_at),
    notesCount:  Number(notesRow?.count ?? 0),
    notes:       row.internal_notes ?? null,
    dob:         row.date_of_birth ? (row.date_of_birth instanceof Date ? row.date_of_birth.toISOString().slice(0, 10) : String(row.date_of_birth).slice(0, 10)) : null,
    address: {
      line1:    row.address_line1 ?? null,
      line2:    row.address_line2 ?? null,
      suburb:   row.suburb ?? null,
      state:    row.state ?? null,
      postcode: row.postcode ?? null,
    },
    vehicles:    vehicleRows.map((v: any) => ({ id: v.id, rego: v.rego, year: v.year, make: v.make, model: v.model, odometer: v.odometer != null ? Number(v.odometer) : null, notesCount: Number(v.notes_count ?? 0), avatarImageId: v.avatar_image_id ?? null, coverImageId: v.cover_image_id ?? null })),
    jobHistory:  jobRows.map((j: any) => ({
      id:      j.id,
      date:    j.completed_at ? formatDate(j.completed_at) : null,
      service: j.service || null,
      vehicle: `${j.make} ${j.model} (${j.rego})`,
      amount:  Number(Number(j.amount).toFixed(2)),
      store:   j.store_name,
      status:  j.status,
      tech:    j.tech ?? null,
      km:              j.km ?? null,
      nextServiceDueKm: j.next_service_due_km ?? null,
    })),
    notifications: {
      pushDevices:      Number(pushRow?.device_count ?? 0),
      pushLastSeenAt:   isoOrNull(pushRow?.last_seen),
      topicsOptedOut,
      quietHours:       quietStart && quietEnd ? { start: quietStart, end: quietEnd } : null,
      preferredContact: (row.preferred_contact ?? 'mobile') as 'mobile' | 'email' | 'sms' | 'app',
      smsOptIn:         Boolean(row.sms_opt_in),
      marketingOptIn:   Boolean(row.marketing_opt_in),
      pushOptIn:        Boolean(row.push_opt_in),
    },
  }
}
