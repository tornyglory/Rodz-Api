import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { userError } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const staffId = event.pathParameters?.id
  if (!staffId) return userError(404, 'USER_NOT_FOUND', 'User not found.')

  try {
    const [[target]] = await db.query<any[]>(
      'SELECT id, store_id FROM staff WHERE id = ? LIMIT 1',
      [staffId],
    )
    if (!target) return userError(404, 'USER_NOT_FOUND', 'User not found.')

    // store_manager can only reset passwords for their own store's staff
    if (ctx.role === 'store_manager' && Number(target.store_id) !== Number(ctx.storeId)) {
      return forbidden()
    }

    const { password } = JSON.parse(event.body ?? '{}')
    if (!password?.trim() || password.trim().length < 8) {
      return userError(422, 'VALIDATION_ERROR', 'password must be at least 8 characters.')
    }

    const hash = await bcrypt.hash(password, 12)
    await db.query(
      `UPDATE staff_auth
       SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL
       WHERE staff_id = ?`,
      [hash, staffId],
    )

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
