import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildBooking, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

const BASE_SELECT = `
  SELECT
    b.id, b.booking_ref, b.customer_id, b.vehicle_id, b.hoist_id, b.assigned_staff_id,
    b.booking_date, b.booking_time, b.slot, b.drop_off_type, b.status,
    b.customer_notes, b.staff_notes, b.created_at,
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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, status, date, page: pageParam, limit: limitParam } = event.queryStringParameters ?? {}

  const limit  = Math.min(Math.max(parseInt(limitParam ?? '0') || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page   = Math.max(parseInt(pageParam ?? '0') || 1, 1)
  const offset = (page - 1) * limit

  try {
    const where: string[] = ['b.cancelled_at IS NULL']
    const params: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store && store !== 'all') {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow) return ok({ bookings: [], pagination: { total: 0, page, limit, pages: 0 } })
        where.push('b.store_id = ?')
        params.push(storeRow.id)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ bookings: [], pagination: { total: 0, page, limit, pages: 0 } })

      if (store && store !== 'all') {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow || !allowedIds.includes(storeRow.id)) return forbidden()
        where.push('b.store_id = ?')
        params.push(storeRow.id)
      } else {
        where.push(`b.store_id IN (${allowedIds.map(() => '?').join(',')})`)
        params.push(...allowedIds)
      }
    }

    if (status && ['pending', 'confirmed', 'rejected'].includes(status)) {
      where.push('b.status = ?')
      params.push(status)
    }

    if (date) {
      where.push('b.booking_date = ?')
      params.push(date)
    }

    const whereClause = where.join(' AND ')

    const [[{ total }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS total FROM bookings b WHERE ${whereClause}`,
      params,
    )

    const [rows] = await db.query<any[]>(
      `${BASE_SELECT} WHERE ${whereClause}
       ORDER BY b.booking_date ASC, b.slot ASC, b.id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )

    return ok({
      bookings: rows.map(buildBooking),
      pagination: {
        total:  Number(total),
        page,
        limit,
        pages:  Math.ceil(Number(total) / limit),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
