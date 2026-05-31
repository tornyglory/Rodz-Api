import * as crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { noContent, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const rawToken  = (event.headers.authorization ?? event.headers.Authorization ?? '').replace(/^Bearer /i, '')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

    // Idempotent — fine if already revoked or never existed
    await db.query(
      'UPDATE staff_sessions SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
      [tokenHash],
    )

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
