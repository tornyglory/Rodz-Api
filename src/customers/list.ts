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
  const { store, search, tag } = event.queryStringParameters ?? {}

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

    const [rows] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.internal_notes,
              c.date_of_birth, c.address_line1, c.address_line2, c.suburb, c.state, c.postcode,
              st.name AS store_name
       FROM customers c
       JOIN stores st ON st.id = c.store_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.last_name, c.first_name
       LIMIT 200`,
      params,
    )

    const customers = await buildCustomerList(db, rows)
    return ok({ customers })
  } catch (err) {
    return serverError(err)
  }
}
