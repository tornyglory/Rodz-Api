import mysql from 'mysql2/promise'

const BOOKING_SELECT = `
  SELECT
    b.id, b.booking_ref, b.customer_id, b.vehicle_id, b.hoist_id, b.assigned_staff_id,
    b.booking_date, b.booking_time, b.slot, b.drop_off_type, b.status,
    b.customer_notes, b.staff_notes, b.created_at,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    c.email                                AS customer_email,
    s.name                                 AS store_name,
    h.name                                 AS hoist_name,
    CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech_label
  FROM bookings b
  JOIN customers c  ON c.id  = b.customer_id
  JOIN stores s     ON s.id  = b.store_id
  LEFT JOIN hoists h   ON h.id  = b.hoist_id
  LEFT JOIN staff st   ON st.id = b.assigned_staff_id`

export const BOOKING_SELECT_BY_ID = `${BOOKING_SELECT} WHERE b.id = ? LIMIT 1`

export function buildBooking(row: any) {
  const toDate = (d: any) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)

  const toTime = (t: any) => {
    if (!t) return null
    if (t instanceof Date) return t.toTimeString().slice(0, 5)
    const s = String(t)
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
    'SELECT store_id FROM staff_store_access WHERE staff_id = ?',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}

export function generateBookingRef(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
