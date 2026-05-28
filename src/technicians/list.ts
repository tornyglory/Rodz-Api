import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)

  try {
    const [rows] = await db.query<any[]>(
      "SELECT id, name, email, phone, specialisation FROM staff WHERE store_id = ? AND role = 'technician' AND active = 1 ORDER BY name",
      [storeId],
    )
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
