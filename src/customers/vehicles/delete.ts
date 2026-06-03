import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  try {
    const [result] = await db.query<any>(
      `UPDATE vehicle_owners
       SET is_current = 0, released_date = CURDATE()
       WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1`,
      [vehicleId, customerId],
    )
    if (result.affectedRows === 0) return notFound('Vehicle')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
