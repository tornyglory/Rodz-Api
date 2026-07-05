import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [result] = await db.query<any>(
      'INSERT INTO customer_chat_sessions (vehicle_id, customer_id) VALUES (?, ?)',
      [vehicleId, ctx.customerId],
    )

    return created({ sessionId: result.insertId })
  } catch (err) {
    return serverError(err)
  }
}
