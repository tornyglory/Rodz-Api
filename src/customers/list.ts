import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { buildCustomerList } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, search, tag, limit: limitParam, offset: offsetParam } = event.queryStringParameters ?? {}

  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0)

  try {
    const where: string[] = ['c.is_active = 1']
    const params: unknown[] = []

    if (ctx.role === 'store_manager' || ctx.role === 'technician') {
      where.push('c.store_id = ?')
      params.push(ctx.storeId)
    } else if (store) {
      where.push('st.name LIKE ?')
      params.push(`%${store}%`)
    }

    if (search) {
      const like = `%${search}%`
      where.push(`(
        CONCAT(c.first_name, ' ', c.last_name) LIKE ?
        OR c.email  LIKE ?
        OR c.mobile LIKE ?
        OR EXISTS (
          SELECT 1 FROM vehicle_owners vo
          JOIN vehicles v ON v.id = vo.vehicle_id
          WHERE vo.customer_id = c.id AND vo.is_current = 1 AND v.rego LIKE ?
        )
      )`)
      params.push(like, like, like, like)
    }

    if (tag && ['VIP', 'Regular', 'New'].includes(tag)) {
      where.push('EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = c.id AND ct.tag = ?)')
      params.push(tag)
    }

    const whereClause = `WHERE ${where.join(' AND ')}`

    // Store-scoped filter for aggregate stats (ignores search/tag)
    const storeWhere: string[] = ['c.is_active = 1']
    const storeParams: unknown[] = []
    if (ctx.role === 'store_manager' || ctx.role === 'technician') {
      storeWhere.push('c.store_id = ?')
      storeParams.push(ctx.storeId)
    } else if (store) {
      storeWhere.push('st.name LIKE ?')
      storeParams.push(`%${store}%`)
    }
    const storeWhereClause = `WHERE ${storeWhere.join(' AND ')}`

    const revenueParams: unknown[] = []
    const revenueStoreFilter =
      ctx.role === 'store_manager' || ctx.role === 'technician'
        ? (revenueParams.push(ctx.storeId), 'AND c.store_id = ?')
        : store
          ? (revenueParams.push(`%${store}%`), 'AND st.name LIKE ?')
          : ''

    const [
      [[{ total }]],
      [rows],
      [[{ vipCustomers }]],
      [[{ newThisMonth }]],
      [[{ lifetimeRevenue }]],
    ] = await Promise.all([
      db.query<any[]>(
        `SELECT COUNT(*) AS total FROM customers c JOIN stores st ON st.id = c.store_id ${whereClause}`,
        params,
      ),
      db.query<any[]>(
        `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.internal_notes,
                c.date_of_birth, c.created_at, c.address_line1, c.address_line2, c.suburb, c.state, c.postcode,
                st.name AS store_name
         FROM customers c
         JOIN stores st ON st.id = c.store_id
         ${whereClause}
         ORDER BY c.last_name, c.first_name
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS vipCustomers
         FROM customers c
         JOIN stores st ON st.id = c.store_id
         ${storeWhereClause}
         AND EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = c.id AND ct.tag = 'VIP')`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS newThisMonth
         FROM customers c
         JOIN stores st ON st.id = c.store_id
         ${storeWhereClause}
         AND YEAR(c.created_at) = YEAR(NOW()) AND MONTH(c.created_at) = MONTH(NOW())`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COALESCE(SUM(i.total), 0) AS lifetimeRevenue
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         JOIN stores st ON st.id = c.store_id
         WHERE i.status IN ('sent', 'paid')
         ${revenueStoreFilter}`,
        revenueParams,
      ),
    ])

    const customers = await buildCustomerList(db, rows)
    return ok({
      customers,
      total:          Number(total),
      limit,
      offset,
      stats: {
        totalCustomers: Number(total),
        vipCustomers:   Number(vipCustomers),
        newThisMonth:   Number(newThisMonth),
        lifetimeRevenue: Number(Number(lifetimeRevenue).toFixed(2)),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
