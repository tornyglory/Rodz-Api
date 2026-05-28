import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = event.pathParameters?.id

  try {
    const [rows] = await db.query<any[]>('SELECT * FROM customers WHERE id = ? LIMIT 1', [id])
    if (!rows[0]) return notFound('Customer')
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
