import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { staffId } = getAuthContext(event)
  const { unread } = event.queryStringParameters ?? {}

  try {
    let query = 'SELECT * FROM notifications WHERE staff_id = ?'
    const params: unknown[] = [staffId]

    if (unread === 'true') { query += ' AND read_at IS NULL' }

    query += ' ORDER BY created_at DESC LIMIT 50'

    const [rows] = await db.query<any[]>(query, params)
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
