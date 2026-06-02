import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../shared/errors'

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const storeId = event.pathParameters?.id
  if (!storeId) return notFound('Store')

  try {
    const [activeStaff] = await db.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM staff WHERE store_id = ? AND is_active = 1',
      [storeId],
    )
    if (activeStaff[0].cnt > 0) {
      return json(409, { error: { code: 'STORE_HAS_STAFF', message: 'Reassign or deactivate all staff before deleting this store.' } })
    }

    const [result] = await db.query<any>('DELETE FROM stores WHERE id = ?', [storeId])
    if (result.affectedRows === 0) return notFound('Store')
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
