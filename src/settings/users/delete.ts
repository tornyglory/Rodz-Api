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

  if (staffId === ctx.staffId) return validationError('Cannot delete your own account.')

  try {
    await db.query('DELETE FROM staff_auth WHERE staff_id = ?', [staffId])
    const [result] = await db.query<any>('DELETE FROM staff WHERE id = ?', [staffId])
    if (result.affectedRows === 0) return notFound('User')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
