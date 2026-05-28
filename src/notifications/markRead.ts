import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { staffId } = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const [result] = await db.query<any>(
      'UPDATE notifications SET read_at = NOW() WHERE id = ? AND staff_id = ? AND read_at IS NULL',
      [id, staffId],
    )
    if (result.affectedRows === 0) return notFound('Notification')

    const [rows] = await db.query<any[]>('SELECT * FROM notifications WHERE id = ? LIMIT 1', [id])
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
