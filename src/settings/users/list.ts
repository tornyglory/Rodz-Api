import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { buildApiUser, STAFF_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const { store, status } = event.queryStringParameters ?? {}

  try {
    const where: string[] = []
    const params: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store) {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow) return ok({ users: [] })
        where.push('s.store_id = ?')
        params.push(storeRow.id)
      }
    } else {
      where.push('s.store_id = ?')
      params.push(ctx.storeId)
    }

    if (status === 'active')   where.push('s.is_active = 1')
    if (status === 'inactive') where.push('s.is_active = 0')

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await db.query<any[]>(
      `${STAFF_SELECT} ${whereClause} ORDER BY s.store_id ASC, s.last_name ASC, s.first_name ASC`,
      params,
    )
    return ok({ users: rows.map(buildApiUser) })
  } catch (err) {
    return serverError(err)
  }
}
