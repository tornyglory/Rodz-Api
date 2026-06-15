import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

const unauthorized = (): APIGatewayProxyResultV2 => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Unauthorized' }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (event.headers['x-api-key'] !== process.env.BOOKING_API_KEY) return unauthorized()
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>('SELECT id, name FROM stores ORDER BY name')
    return ok({ stores: rows.map((r) => ({ id: r.id, name: r.name })) })
  } catch (err) {
    return serverError(err)
  }
}
