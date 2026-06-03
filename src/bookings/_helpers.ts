import mysql from 'mysql2/promise'

export function buildBooking(row: any) {
  return {
    id:              row.id,
    customer:        row.customer_name,
    customerEmail:   row.customer_email ?? null,
    customerId:      row.customer_id ?? null,
    vehicle:         row.vehicle_display,
    rego:            row.rego,
    vehicleId:       row.vehicle_id ?? null,
    service:         row.service,
    slot:            row.slot,
    date:            row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    type:            row.type,
    status:          row.status,
    store:           row.store_name,
    createdAt:       row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    assignedHoist:   row.assigned_hoist_label ?? null,
    assignedHoistId: row.assigned_hoist_id ?? null,
    assignedTech:    row.assigned_staff_label ?? null,
    assignedStaffId: row.assigned_staff_id ?? null,
    dropOffTime:     row.drop_off_time ?? null,
    notes:           row.notes ?? null,
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
