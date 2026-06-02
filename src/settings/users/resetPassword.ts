import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, notFound, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const staffId = event.pathParameters?.id
  if (!staffId) return notFound('User')

  try {
    const { password } = JSON.parse(event.body ?? '{}')
    if (!password?.trim() || password.trim().length < 8) {
      return validationError('password must be at least 8 characters.')
    }

    const hash = await bcrypt.hash(password, 12)
    const [result] = await db.query<any>(
      `UPDATE staff_auth
       SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL
       WHERE staff_id = ?`,
      [hash, staffId],
    )
    if (result.affectedRows === 0) return notFound('User')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
