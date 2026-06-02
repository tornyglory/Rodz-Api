import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const { storeId, hoistId } = event.pathParameters ?? {}
  if (!storeId || !hoistId) return notFound('Hoist')

  try {
    await db.query('DELETE FROM hoist_roles WHERE hoist_id = ?', [hoistId])
    const [result] = await db.query<any>(
      'DELETE FROM hoists WHERE id = ? AND store_id = ?',
      [hoistId, storeId],
    )
    if (result.affectedRows === 0) return notFound('Hoist')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
