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
    const [rows] = await db.query<any[]>(
      `SELECT id, name, category, description
       FROM service_types
       WHERE is_active = 1 AND is_bookable = 1
       ORDER BY category, sort_order, name`,
    )

    return ok({
      serviceTypes: rows.map((r) => ({
        id:          r.id,
        name:        r.name,
        category:    r.category,
        description: r.description ?? null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
