import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, badRequest, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId, staffId } = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const { customer_id, vehicle_id, scheduled_at, notes } = body

    if (!customer_id || !scheduled_at) {
      return badRequest('customer_id and scheduled_at are required')
    }

    const [result] = await db.query<any>(
      `INSERT INTO bookings (customer_id, vehicle_id, store_id, scheduled_at, notes, created_by, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [customer_id, vehicle_id ?? null, storeId, scheduled_at, notes ?? null, staffId],
    )

    const [rows] = await db.query<any[]>('SELECT * FROM bookings WHERE id = ? LIMIT 1', [result.insertId])
    return created(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
