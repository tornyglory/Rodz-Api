import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'
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

    const [[item]] = await db.query<any[]>(
      'SELECT id, quantity_ordered FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? LIMIT 1',
      [itemId, poId],
    )
    if (!item) return poError(404, 'ITEM_NOT_FOUND', 'Item not found on this purchase order.')

    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { description, quantityOrdered, unitCost, notes, quantityReceived } = body

    const hasEditFields = description !== undefined || quantityOrdered !== undefined || unitCost !== undefined || notes !== undefined
    const hasReceiveField = quantityReceived !== undefined

    if (!hasEditFields && !hasReceiveField) return validationError('No valid fields to update.')

    // ── Edit item details — draft only ─────────────────────────────────────
    if (hasEditFields) {
      if (po.status !== 'draft') {
        return poError(409, 'INVALID_STATE', 'Item details can only be edited on a draft purchase order.')
      }
      const updates: [string, unknown][] = []
      if (description !== undefined) updates.push(['description', description])
      if (quantityOrdered !== undefined) updates.push(['quantity_ordered', Number(quantityOrdered)])
      if (unitCost !== undefined) updates.push(['unit_cost', Number(unitCost)])
      if (notes !== undefined) updates.push(['notes', notes ?? null])

      const set = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), itemId]
      await db.query(`UPDATE purchase_order_items SET ${set} WHERE id = ?`, values)

      if (quantityOrdered !== undefined || unitCost !== undefined) {
        await recalcPOTotals(db, Number(poId))
      }
    }

    // ── Record received qty — ordered/partial only ─────────────────────────
    if (hasReceiveField) {
      if (!['ordered', 'partial'].includes(po.status)) {
        return poError(409, 'INVALID_STATE', 'Can only receive items on an ordered or partially received purchase order.')
      }
      if (Number(quantityReceived) < 0) return validationError('quantityReceived cannot be negative.')

      await db.query(
        'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?',
        [Number(quantityReceived), itemId],
      )

      const [allItems] = await db.query<any[]>(
        'SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = ?',
        [poId],
      )
      const allReceived = allItems.every((r: any) => Number(r.quantity_received) >= Number(r.quantity_ordered))
      const anyReceived = allItems.some((r: any) => Number(r.quantity_received) > 0)

      if (allReceived) {
        await db.query("UPDATE purchase_orders SET status = 'received', received_at = NOW() WHERE id = ?", [poId])
      } else if (anyReceived && po.status === 'ordered') {
        await db.query("UPDATE purchase_orders SET status = 'partial' WHERE id = ?", [poId])
      }
    }

    const [[row]] = await db.query<any[]>(`${PO_SELECT} WHERE po.id = ? LIMIT 1`, [poId])
    const items = await getPOItems(db, Number(poId))
    return ok({ purchaseOrder: buildPO(row, items) })
  } catch (err) {
    return serverError(err)
  }
}
