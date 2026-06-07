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
      return poError(409, 'INVALID_STATE', 'Items can only be added to a draft purchase order.')
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { description, quantityOrdered, unitCost, partId, serviceJobId, notes } = body

    if (!description) return validationError('description is required.')
    if (quantityOrdered == null) return validationError('quantityOrdered is required.')
    if (unitCost == null) return validationError('unitCost is required.')

    await db.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, part_id, service_job_id, description, quantity_ordered, quantity_received, unit_cost, notes)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [poId, partId ?? null, serviceJobId ?? null, description, Number(quantityOrdered), Number(unitCost), notes ?? null],
    )

    await recalcPOTotals(db, Number(poId))

    const [[row]] = await db.query<any[]>(`${PO_SELECT} WHERE po.id = ? LIMIT 1`, [poId])
    const items = await getPOItems(db, Number(poId))
    return ok({ purchaseOrder: buildPO(row, items) })
  } catch (err) {
    return serverError(err)
  }
}
