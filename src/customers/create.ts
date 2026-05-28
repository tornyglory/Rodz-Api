import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, badRequest, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const { name, email, phone, address } = body

    if (!name) return badRequest('name is required')

    const [result] = await db.query<any>(
      'INSERT INTO customers (name, email, phone, address, store_id) VALUES (?, ?, ?, ?, ?)',
      [name, email ?? null, phone ?? null, address ?? null, storeId],
    )

    const [rows] = await db.query<any[]>('SELECT * FROM customers WHERE id = ? LIMIT 1', [result.insertId])
    return created(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
