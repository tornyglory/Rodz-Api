import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, invalidCredentials, notFound, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as { currentPassword?: string; newPassword?: string }
    if (!body.currentPassword || !body.newPassword) {
      return validationError('currentPassword and newPassword are required.')
    }
    if (body.newPassword.length < 8) {
      return validationError('New password must be at least 8 characters.')
    }

    const [[row]] = await db.query<any[]>(
      'SELECT password_hash FROM customer_auth WHERE customer_id = ? LIMIT 1',
      [ctx.customerId],
    )
    if (!row) return notFound('Account')

    const valid = await bcrypt.compare(body.currentPassword, row.password_hash)
    if (!valid) return invalidCredentials()

    const newHash = await bcrypt.hash(body.newPassword, 12)
    await db.query(
      'UPDATE customer_auth SET password_hash = ?, updated_at = NOW() WHERE customer_id = ?',
      [newHash, ctx.customerId],
    )

    return ok({ message: 'Password updated.' })
  } catch (err) {
    return serverError(err)
  }
}
