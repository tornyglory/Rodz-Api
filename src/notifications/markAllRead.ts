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

  try {
    const [result] = await db.query<any>(
      'UPDATE staff_notifications SET read_at = NOW() WHERE staff_id = ? AND read_at IS NULL',
      [staffId],
    )
    return ok({ updated: result.affectedRows })
  } catch (err) {
    return serverError(err)
  }
}
