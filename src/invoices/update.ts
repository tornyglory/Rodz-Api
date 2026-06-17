import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { invoiceError, INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, computeTotals, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(`SELECT * FROM invoices WHERE id = ? LIMIT 1`, [id])
    if (!row) return notFound('Invoice')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return notFound('Invoice')
    }
    if (ctx.role === 'technician' && String(row.staff_id) !== String(ctx.staffId))
      return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { notes, odometerIn, staffId, items } = body

    // Item replacement is only permitted on drafts
    if (items != null && row.status !== 'draft')
      return invoiceError(409, 'NOT_DRAFT', 'Items can only be edited on draft invoices.')

    if (notes     !== undefined) await db.query('UPDATE invoices SET notes = ? WHERE id = ?',       [notes ?? null, id])
    if (odometerIn !== undefined) await db.query('UPDATE invoices SET odometer_in = ? WHERE id = ?', [odometerIn ?? null, id])
    if (staffId   !== undefined) await db.query('UPDATE invoices SET staff_id = ? WHERE id = ?',    [staffId, id])

    if (Array.isArray(items)) {
      const normItems = items.map((item: any, i: number) => ({
        description: String(item.description ?? '').trim(),
        type:        item.type ?? 'other',
        hours:       item.hours != null ? Number(item.hours) : null,
        qty:         item.qty   != null ? Number(item.qty)   : 1,
        unitPrice:   Number(item.unitPrice ?? 0),
        sortOrder:   item.sortOrder ?? i,
      }))
      const { subtotal, gst, total } = computeTotals(normItems)

      await db.query('DELETE FROM invoice_items WHERE invoice_id = ?', [id])
      for (const item of normItems) {
        await db.query(
          `INSERT INTO invoice_items (invoice_id, description, type, hours, qty, unit_price, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, item.description, item.type, item.hours, item.qty, item.unitPrice, item.sortOrder],
        )
      }
      await db.query(
        'UPDATE invoices SET subtotal = ?, gst = ?, total = ? WHERE id = ?',
        [subtotal, gst, total, id],
      )
    }

    const [[updated]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [id])
    const itemsMap = await getInvoiceItems(db, [row.id])
    return ok({ invoice: buildInvoice(updated, itemsMap.get(row.id) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
