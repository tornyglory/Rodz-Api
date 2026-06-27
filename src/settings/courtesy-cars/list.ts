import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { COURTESY_CAR_SELECT_ALL, buildCourtesyCar } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const [rows] = await db.query<any[]>(COURTESY_CAR_SELECT_ALL)
    return ok({ courtesyCars: rows.map(buildCourtesyCar) })
  } catch (err) {
    return serverError(err)
  }
}
