import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)
  const { status } = event.queryStringParameters ?? {}

  try {
    let query = 'SELECT * FROM quotes WHERE store_id = ?'
    const params: unknown[] = [storeId]

    if (status) { query += ' AND status = ?'; params.push(status) }

    query += ' ORDER BY created_at DESC LIMIT 100'

    const [rows] = await db.query<any[]>(query, params)
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
