import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { created, forbidden, serverError } from '../../../shared/errors'
import { buildHoist, hoistError, getAllowedStoreIds, HOIST_SELECT_BY_ID } from '../../../hoists/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const storeId = event.pathParameters?.storeId

  try {
    const [[storeRow]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE id = ? LIMIT 1',
      [storeId],
    )
    if (!storeRow) return hoistError(404, 'STORE_NOT_FOUND', 'Store not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(Number(storeId))) return forbidden()
    }

    const { label } = JSON.parse(event.body ?? '{}')
    if (!label?.trim()) return hoistError(422, 'VALIDATION_ERROR', 'label is required.')

    const hoistType = /tyre/i.test(label) ? 'tyre_bay' : 'two_post'

    const [result] = await db.query<any>(
      'INSERT INTO hoists (store_id, name, hoist_type, is_active, service_roles) VALUES (?, ?, ?, 1, ?)',
      [storeId, label.trim(), hoistType, JSON.stringify([])],
    )

    const [[row]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [result.insertId])
    return created({ hoist: buildHoist(row) })
  } catch (err) {
    return serverError(err)
  }
}
