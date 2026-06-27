import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const staffId  = event.pathParameters?.id
  const entryId  = event.pathParameters?.entryId

  try {
    const [[entry]] = await db.query<any[]>(
      'SELECT id FROM staff_leave WHERE id = ? AND staff_id = ? LIMIT 1', [entryId, staffId],
    )
    if (!entry) return notFound('Leave entry')

    await db.query('DELETE FROM staff_leave WHERE id = ?', [entryId])
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
