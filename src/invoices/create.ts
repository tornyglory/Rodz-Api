import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { invoiceError, INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, generateInvoiceNumber, computeTotals, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  try {
    const body        = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { customerId, vehicleRego, storeId, staffId, notes, odometerIn, items = [] } = body

    if (!customerId)  return validationError('customerId is required.')
    if (!vehicleRego) return validationError('vehicleRego is required.')
    if (!storeId)     return validationError('storeId is required.')
    if (!staffId)     return validationError('staffId is required.')
    if (!Array.isArray(items)) return validationError('items must be an array.')

    for (const [i, item] of items.entries()) {
      if (!item.description) return validationError(`items[${i}].description is required.`)
      if (!item.type || !['labour', 'part', 'other'].includes(item.type))
        return validationError(`items[${i}].type must be labour, part, or other.`)
      if (item.unitPrice == null || Number(item.unitPrice) < 0)
        return validationError(`items[${i}].unitPrice is required.`)
    }

    // Store access
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(Number(storeId))) return forbidden()
    }

    // Verify customer exists
    const [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [customerId],
    )
    if (!customer) return invoiceError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.')

    const invoiceNumber = await generateInvoiceNumber(db)
    const normItems = items.map((item: any, i: number) => ({
      description: String(item.description).trim(),
      type:        item.type,
      hours:       item.hours ? Number(item.hours) : null,
      qty:         item.qty != null ? Number(item.qty) : 1,
      unitPrice:   Number(item.unitPrice),
      sortOrder:   item.sortOrder ?? i,
    }))
    const { subtotal, gst, total } = computeTotals(normItems)

    const [ins] = await db.query<any>(
      `INSERT INTO invoices
         (invoice_number, store_id, staff_id, customer_id, vehicle_rego,
          notes, odometer_in, subtotal, gst, total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [invoiceNumber, storeId, staffId, customerId, String(vehicleRego).trim().toUpperCase(),
       notes ?? null, odometerIn ?? null, subtotal, gst, total],
    )
    const invoiceId = ins.insertId

    for (const item of normItems) {
      await db.query(
        `INSERT INTO invoice_items (invoice_id, description, type, hours, qty, unit_price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, item.description, item.type, item.hours, item.qty, item.unitPrice, item.sortOrder],
      )
    }

    const [[row]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [invoiceId])
    const itemsMap = await getInvoiceItems(db, [invoiceId])
    return created({ invoice: buildInvoice(row, itemsMap.get(invoiceId) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
