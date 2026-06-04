import mysql from 'mysql2/promise'

const HOIST_SELECT = `
  SELECT
    h.id, h.name, h.hoist_type, h.assigned_staff_id, h.service_roles, h.store_id,
    s.name AS store_name,
    CONCAT(st.first_name, ' ', LEFT(st.last_name, 1), '.') AS tech_label,
    COALESCE(jstat.has_in_progress, 0)       AS has_in_progress,
    COALESCE(jstat.has_awaiting_parts, 0)    AS has_awaiting_parts,
    COALESCE(jstat.has_awaiting_approval, 0) AS has_awaiting_approval,
    COALESCE(jstat.active_jobs, 0)           AS active_jobs,
    COALESCE(jstat.total_jobs, 0)            AS total_jobs
  FROM hoists h
  JOIN stores s ON s.id = h.store_id
  LEFT JOIN staff st ON st.id = h.assigned_staff_id
  LEFT JOIN (
    SELECT
      j.hoist_id,
      MAX(j.status = 'in_progress')       AS has_in_progress,
      MAX(j.status = 'awaiting_parts')    AS has_awaiting_parts,
      MAX(j.status = 'awaiting_approval') AS has_awaiting_approval,
      SUM(CASE WHEN j.status NOT IN ('completed','invoiced','cancelled') THEN 1 ELSE 0 END) AS active_jobs,
      COUNT(*)                            AS total_jobs
    FROM service_jobs j
    JOIN bookings b ON b.id = j.booking_id
    WHERE b.booking_date = CURDATE()
    GROUP BY j.hoist_id
  ) jstat ON jstat.hoist_id = h.id
  WHERE h.is_active = 1`

export const HOIST_SELECT_BY_ID = `${HOIST_SELECT} AND h.id = ? LIMIT 1`

export function buildHoist(row: any) {
  const roles = row.service_roles
    ? (typeof row.service_roles === 'string' ? JSON.parse(row.service_roles) : row.service_roles)
    : []

  let status = 'available'
  if (Number(row.total_jobs) === 0) {
    status = 'available'
  } else if (Number(row.has_in_progress)) {
    status = 'in_progress'
  } else if (Number(row.has_awaiting_parts)) {
    status = 'awaiting_parts'
  } else if (Number(row.has_awaiting_approval)) {
    status = 'awaiting_approval'
  } else if (Number(row.active_jobs) === 0) {
    status = 'completed'
  }

  return {
    id:              row.id,
    label:           row.name,
    store:           (row.store_name ?? '').replace(/^Rodz /, ''),
    isTyreBay:       row.hoist_type === 'tyre_bay',
    sortOrder:       row.id,
    roles,
    assignedTech:    row.tech_label ?? null,
    assignedStaffId: row.assigned_staff_id ?? null,
    status,
  }
}

export function hoistError(statusCode: number, code: string, message: string) {
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
