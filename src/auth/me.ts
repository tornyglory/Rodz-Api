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

  try {
    const [rows] = await db.query<any[]>(
      'SELECT id, name, email, role, store_id FROM staff WHERE id = ? AND active = 1 LIMIT 1',
      [staffId],
    )
    if (!rows[0]) return notFound('Staff member')
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
