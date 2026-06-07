import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, serverError } from '../shared/errors'
import { getAllowedStoreIds, poError } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[po]] = await db.query<any[]>(
      'SELECT id, store_id, status FROM purchase_orders WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [id],
    )
    if (!po) return poError(404, 'NOT_FOUND', 'Purchase order not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(po.store_id)) return forbidden()
    }

    if (!['draft', 'ordered'].includes(po.status)) {
      return poError(409, 'PO_NOT_CANCELLABLE', 'Only draft or ordered purchase orders can be cancelled.')
    }

    await db.query(
      "UPDATE purchase_orders SET status = 'cancelled', deleted_at = NOW() WHERE id = ?",
      [id],
    )

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
