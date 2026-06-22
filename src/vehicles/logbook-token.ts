import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import crypto from 'crypto'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db   = getPool()
  getAuthContext(event)
  const rego = event.pathParameters?.rego?.toUpperCase()

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT rego, logbook_token FROM vehicles WHERE rego = ? AND is_active = 1 LIMIT 1',
      [rego],
    )
    if (!vehicle) return notFound('Vehicle')

    if (vehicle.logbook_token) {
      return ok({ token: vehicle.logbook_token })
    }

    const token = crypto.randomBytes(32).toString('hex')
    await db.query('UPDATE vehicles SET logbook_token = ? WHERE rego = ?', [token, rego])
    return ok({ token })
  } catch (err) {
    return serverError(err)
  }
}
