import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>('SELECT * FROM stores ORDER BY name')
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
