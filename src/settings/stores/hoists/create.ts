import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const storeId = event.pathParameters?.storeId
  if (!storeId) return notFound('Store')

  try {
    const { label } = JSON.parse(event.body ?? '{}')
    if (!label?.trim()) return validationError('label is required.')

    const [storeRows] = await db.query<any[]>('SELECT id FROM stores WHERE id = ? LIMIT 1', [storeId])
    if (storeRows.length === 0) return notFound('Store')

    const [result] = await db.query<any>(
      'INSERT INTO hoists (store_id, name) VALUES (?, ?)',
      [storeId, label.trim()],
    )

    return created({ hoist: { id: result.insertId, label: label.trim(), roles: [] } })
  } catch (err) {
    return serverError(err)
  }
}
