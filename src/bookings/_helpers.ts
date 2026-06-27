import mysql from 'mysql2/promise'

const BOOKING_SELECT = `
  SELECT
    b.id, b.booking_ref, b.customer_id, b.vehicle_id, b.hoist_id, b.assigned_staff_id,
    b.booking_date, b.booking_time, b.slot, b.drop_off_type, b.status,
    b.customer_notes, b.staff_notes, b.courtesy_car_requested, b.created_at,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    c.email                                AS customer_email,
    s.name                                 AS store_name,
    h.name                                 AS hoist_name,
    CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech_label,
    CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
    v.rego                                 AS vehicle_rego
  FROM bookings b
  JOIN customers c  ON c.id  = b.customer_id
  JOIN stores s     ON s.id  = b.store_id
  LEFT JOIN hoists h   ON h.id  = b.hoist_id
  LEFT JOIN staff st   ON st.id = b.assigned_staff_id
  LEFT JOIN vehicles v ON v.id  = b.vehicle_id`

export const BOOKING_SELECT_BY_ID = `${BOOKING_SELECT} WHERE b.id = ? LIMIT 1`

export function buildBooking(row: any, services: any[] = []) {
  const toDate = (d: any) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)

  const toTime = (t: any) => {
    if (!t) return null
    if (t instanceof Date) return t.toTimeString().slice(0, 5)
    const s = String(t)
    if (s === '00:00:00' || s === '00:00') return null
    // TIME column returns "HH:MM:SS"
    if (s.length <= 8 && s.includes(':')) return s.slice(0, 5)
    // DATETIME string "YYYY-MM-DD HH:MM:SS"
    if (s.length >= 16) return s.slice(11, 16)
    return null
  }

  return {
    id:              row.id,
    bookingRef:      row.booking_ref,
    customerId:      row.customer_id,
    customer:        row.customer_name,
    customerEmail:   row.customer_email ?? null,
    vehicleId:       row.vehicle_id ?? null,
    vehicle:         row.vehicle_label ?? null,
    rego:            row.vehicle_rego ?? null,
    slot:            row.slot,
    date:            toDate(row.booking_date),
    type:            row.drop_off_type ?? null,
    status:          row.status,
    store:           row.store_name,
    createdAt:       row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    assignedHoist:   row.hoist_name ?? null,
    assignedHoistId: row.hoist_id ?? null,
    assignedTech:    row.tech_label ?? null,
    assignedStaffId: row.assigned_staff_id ?? null,
    dropOffTime:     toTime(row.booking_time),
    notes:           row.customer_notes ?? null,
    staffNotes:      row.staff_notes ?? null,
    courtesyCar:     Boolean(row.courtesy_car_requested),
    services:        services.map((s) => ({
      serviceTypeId:       s.service_type_id,
      name:                s.name,
      category:            s.category,
      customerDescription: s.customer_description ?? null,
    })),
  }
}

export function bookingError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}

export async function getAllowedStoreIds(db: mysql.Pool, staffId: string): Promise<number[]> {
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    'SELECT store_id FROM staff_store_access WHERE staff_id = ? AND revoked_at IS NULL',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}

export async function getBookingServices(
  db: mysql.Pool,
  bookingIds: number[],
): Promise<Map<number, any[]>> {
  if (bookingIds.length === 0) return new Map()
  const placeholders = bookingIds.map(() => '?').join(',')
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    `SELECT bs.booking_id, bs.service_type_id, bs.customer_description,
            st.name, st.category
     FROM booking_services bs
     JOIN service_types st ON st.id = bs.service_type_id
     WHERE bs.booking_id IN (${placeholders})
     ORDER BY bs.booking_id, bs.sort_order`,
    bookingIds,
  )
  const map = new Map<number, any[]>()
  for (const row of rows) {
    if (!map.has(row.booking_id)) map.set(row.booking_id, [])
    map.get(row.booking_id)!.push(row)
  }
  return map
}

export async function setBookingServices(
  db: mysql.Pool,
  bookingId: number,
  services: Array<{ serviceTypeId: number; customerDescription?: string | null }>,
): Promise<void> {
  await db.query('DELETE FROM booking_services WHERE booking_id = ?', [bookingId])
  if (services.length === 0) return
  const values = services.map((s, i) => [bookingId, s.serviceTypeId, s.customerDescription ?? null, i])
  await db.query(
    'INSERT INTO booking_services (booking_id, service_type_id, customer_description, sort_order) VALUES ?',
    [values],
  )
}

// Excludes lookalike characters: 0, O, I, 1
export function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
