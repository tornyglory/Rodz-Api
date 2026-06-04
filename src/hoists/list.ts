import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildHoist, getAllowedStoreIds, HOIST_SELECT_BY_ID } from './_helpers'

const ready = bootstrap()

const HOIST_SELECT_ALL = `
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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['h.is_active = 1']
    const params: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store && store !== 'all') {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow) return ok({ hoists: [] })
        where.push('h.store_id = ?')
        params.push(storeRow.id)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ hoists: [] })

      if (store && store !== 'all') {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow || !allowedIds.includes(storeRow.id)) return forbidden()
        where.push('h.store_id = ?')
        params.push(storeRow.id)
      } else {
        where.push(`h.store_id IN (${allowedIds.map(() => '?').join(',')})`)
        params.push(...allowedIds)
      }
    }

    // Replace the WHERE clause in the base query
    const query = `
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
      WHERE ${where.join(' AND ')}
      ORDER BY h.store_id, h.id`

    const [rows] = await db.query<any[]>(query, params)
    return ok({ hoists: rows.map(buildHoist) })
  } catch (err) {
    return serverError(err)
  }
}
