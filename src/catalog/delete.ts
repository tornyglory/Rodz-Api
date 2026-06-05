import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role !== 'store_manager' && ctx.role !== 'super_admin') return forbidden()

  try {
    const [result] = await db.query<any>(
      'UPDATE catalog_items SET is_active = 0 WHERE id = ?',
      [id],
    )
    if (result.affectedRows === 0) return notFound('Catalog item')

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
