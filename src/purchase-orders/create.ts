import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { PO_SELECT, buildPO, getAllowedStoreIds, getPOItems, generatePONumber, poError } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { supplier, items, expectedDelivery, notes } = body
    let { storeId } = body

    if (!supplier) return validationError('supplier is required.')
    if (!Array.isArray(items) || items.length === 0) return validationError('items must be a non-empty array.')

    for (const item of items) {
      if (!item.description) return validationError('Each item must have a description.')
      if (item.quantityOrdered == null) return validationError('Each item must have a quantityOrdered.')
      if (item.unitCost == null) return validationError('Each item must have a unitCost.')
    }

    if (!storeId) storeId = ctx.storeId
    if (!storeId) return validationError('storeId is required.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(Number(storeId))) return forbidden()
    }

    // ── Calculate totals ────────────────────────────────────────────────────
    let subtotal = 0
    for (const item of items) {
      subtotal += Number(item.quantityOrdered) * Number(item.unitCost)
    }
    const gst = Math.round(subtotal * 0.1 * 100) / 100
    const total = subtotal + gst

    // ── Generate PO number & insert header ──────────────────────────────────
    const poNumber = await generatePONumber(db)

    const [result] = await db.query<any>(
      `INSERT INTO purchase_orders
         (po_number, store_id, supplier, status, expected_delivery, notes,
          subtotal, gst_amount, total, created_by_staff_id)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      [poNumber, storeId, supplier, expectedDelivery ?? null, notes ?? null,
       subtotal, gst, total, ctx.staffId],
    )
    const poId: number = result.insertId

    // ── Insert items ────────────────────────────────────────────────────────
    const itemRows = items.map((item: any) => [
      poId,
      item.partId ?? null,
      item.serviceJobId ?? null,
      item.description,
      item.partNumber ?? null,
      Number(item.quantityOrdered),
      0,
      Number(item.unitCost),
      item.notes ?? null,
    ])
    await db.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, part_id, service_job_id, description, part_number, quantity_ordered, quantity_received, unit_cost, notes)
       VALUES ?`,
      [itemRows],
    )

    const [[row]] = await db.query<any[]>(
      `${PO_SELECT} WHERE po.id = ? LIMIT 1`,
      [poId],
    )
    const poItems = await getPOItems(db, poId)
    return created({ purchaseOrder: buildPO(row, poItems) })
  } catch (err) {
    return serverError(err)
  }
}
