import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { PO_SELECT, buildPO, getAllowedStoreIds, getPOItems, recalcPOTotals, poError } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const poId = event.pathParameters?.id
  const itemId = event.pathParameters?.itemId

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[po]] = await db.query<any[]>(
      'SELECT id, store_id, status FROM purchase_orders WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [poId],
    )
    if (!po) return poError(404, 'NOT_FOUND', 'Purchase order not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(po.store_id)) return forbidden()
    }

    if (po.status !== 'draft') {
      return poError(409, 'INVALID_STATE', 'Items can only be removed from a draft purchase order.')
    }

    const [result] = await db.query<any>(
      'DELETE FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?',
      [itemId, poId],
    )
    if (result.affectedRows === 0) return poError(404, 'ITEM_NOT_FOUND', 'Item not found on this purchase order.')

    await recalcPOTotals(db, Number(poId))

    const [[row]] = await db.query<any[]>(`${PO_SELECT} WHERE po.id = ? LIMIT 1`, [poId])
    const items = await getPOItems(db, Number(poId))
    return ok({ purchaseOrder: buildPO(row, items) })
  } catch (err) {
    return serverError(err)
  }
}
