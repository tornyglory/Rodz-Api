import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, serverError } from '../../shared/errors'
import { userError } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const staffId = event.pathParameters?.id
  if (!staffId) return userError(404, 'USER_NOT_FOUND', 'User not found.')

  if (String(staffId) === String(ctx.staffId)) {
    return userError(422, 'CANNOT_DELETE_SELF', 'Cannot delete your own account.')
  }

  try {
    const [[target]] = await db.query<any[]>(
      'SELECT id FROM staff WHERE id = ? LIMIT 1',
      [staffId],
    )
    if (!target) return userError(404, 'USER_NOT_FOUND', 'User not found.')

    // Clear hoist assignments
    await db.query(
      'UPDATE hoists SET assigned_staff_id = NULL WHERE assigned_staff_id = ?',
      [staffId],
    )

    // Clear job tech assignments
    await db.query(
      `DELETE FROM service_job_staff WHERE staff_id = ?`,
      [staffId],
    )

    await db.query('DELETE FROM staff_auth WHERE staff_id = ?', [staffId])
    await db.query('DELETE FROM staff WHERE id = ?', [staffId])

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
