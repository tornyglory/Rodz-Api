import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { noContent, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = event.pathParameters?.id

  try {
    const [result] = await db.query<any>('DELETE FROM bookings WHERE id = ?', [id])
    if (result.affectedRows === 0) return notFound('Booking')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
