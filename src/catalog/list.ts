import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { search, category } = event.queryStringParameters ?? {}

  try {
    let query = 'SELECT * FROM catalog WHERE active = 1'
    const params: unknown[] = []

    if (category) { query += ' AND category = ?'; params.push(category) }
    if (search)   { query += ' AND (name LIKE ? OR sku LIKE ?)'; const like = `%${search}%`; params.push(like, like) }

    query += ' ORDER BY name LIMIT 200'

    const [rows] = await db.query<any[]>(query, params)
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
