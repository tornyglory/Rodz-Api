import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { PO_SELECT, buildPO, getAllowedStoreIds, getPOItems, poError, VALID_TRANSITIONS } from './_helpers'

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

    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { status, expectedDelivery, supplierInvoiceRef, notes } = body

    if (status === undefined && expectedDelivery === undefined && supplierInvoiceRef === undefined && notes === undefined) {
      return validationError('No valid fields to update.')
    }

    const updates: [string, unknown][] = []

    if (status != null) {
      const allowed = VALID_TRANSITIONS[po.status] ?? []
      if (!allowed.includes(String(status))) {
        return poError(409, 'INVALID_TRANSITION', `Cannot transition from "${po.status}" to "${status}".`)
      }
      updates.push(['status', status])
      if (status === 'ordered')  updates.push(['ordered_at', new Date()])
      if (status === 'received') updates.push(['received_at', new Date()])
    }

    if (expectedDelivery !== undefined) updates.push(['expected_delivery', expectedDelivery ?? null])
    if (supplierInvoiceRef !== undefined) updates.push(['supplier_invoice_ref', supplierInvoiceRef ?? null])
    if (notes !== undefined) updates.push(['notes', notes ?? null])

    if (updates.length > 0) {
      const set = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), id]
      await db.query(`UPDATE purchase_orders SET ${set} WHERE id = ?`, values)
    }

    const [[row]] = await db.query<any[]>(`${PO_SELECT} WHERE po.id = ? LIMIT 1`, [id])
    const items = await getPOItems(db, Number(id))
    return ok({ purchaseOrder: buildPO(row, items) })
  } catch (err) {
    return serverError(err)
  }
}
