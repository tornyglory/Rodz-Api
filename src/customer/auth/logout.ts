import * as crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    const authHeader = event.headers['authorization'] ?? event.headers['Authorization'] ?? ''
    const token = authHeader.replace(/^Bearer /i, '').trim()

    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
      const db = getPool()
      await db.query('DELETE FROM customer_sessions WHERE token_hash = ?', [tokenHash])
    }

    return ok({ message: 'Logged out.' })
  } catch (err) {
    return serverError(err)
  }
}
