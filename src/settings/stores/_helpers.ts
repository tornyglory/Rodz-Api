import mysql from 'mysql2/promise'
import { buildHoist } from '../../hoists/_helpers'

const HOIST_SELECT_FOR_STORE = `
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
  WHERE h.is_active = 1 AND h.store_id = ?
  ORDER BY h.id`

export async function buildStore(db: mysql.Pool, storeId: number | string) {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, address_line1, suburb, state, postcode, phone FROM stores WHERE id = ? LIMIT 1',
    [storeId],
  )
  if (!store) return null

  const addressParts = [
    store.address_line1,
    store.suburb,
    [store.state, store.postcode].filter(Boolean).join(' '),
  ].filter(Boolean)

  const [hoistRows] = await db.query<any[]>(HOIST_SELECT_FOR_STORE, [storeId])

  return {
    id:      store.id as number,
    name:    store.name as string,
    address: addressParts.join(', '),
    phone:   (store.phone ?? '') as string,
    hoists:  hoistRows.map(buildHoist),
  }
}
