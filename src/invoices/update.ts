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
    const { notes, odometerIn, dueDate, staffId, items } = body

    // Item replacement is only permitted on drafts
    if (items != null && row.status !== 'draft')
      return invoiceError(409, 'NOT_DRAFT', 'Items can only be edited on draft invoices.')

    if (notes      !== undefined) await db.query('UPDATE invoices SET notes = ? WHERE id = ?',        [notes ?? null, id])
    if (odometerIn !== undefined) await db.query('UPDATE invoices SET odometer_in = ? WHERE id = ?',  [odometerIn ?? null, id])
    if (dueDate    !== undefined) await db.query('UPDATE invoices SET due_date = ? WHERE id = ?',     [dueDate ?? null, id])
    if (staffId    !== undefined) await db.query('UPDATE invoices SET staff_id = ? WHERE id = ?',     [staffId, id])

    if (Array.isArray(items)) {
      const normItems = items.map((item: any, i: number) => ({
        id:          item.id ? Number(item.id) : null,
        description: String(item.description ?? '').trim(),
        type:        item.type ?? 'other',
        hours:       item.hours != null ? Number(item.hours) : null,
        qty:         item.qty   != null ? Number(item.qty)   : 1,
        unitPrice:   Number(item.unitPrice ?? 0),
        sortOrder:   item.sortOrder ?? i,
      }))
      const { subtotal, gst, total } = computeTotals(normItems)

      // Load current items ordered by sort_order so positional fallback is stable
      const [currentItems] = await db.query<any[]>(
        'SELECT id FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id',
        [id],
      )

      // Resolve each incoming item to an existing DB row — by explicit id if present,
      // otherwise by position. This preserves photos even when the frontend omits ids.
      const resolvedIds: (number | null)[] = normItems.map((item, i) =>
        item.id ?? (currentItems[i]?.id ?? null),
      )

      // Delete current items not accounted for in the resolved set
      const keptIds = new Set(resolvedIds.filter(Boolean) as number[])
      const toDelete = currentItems.map((r: any) => r.id).filter((cid: number) => !keptIds.has(cid))
      if (toDelete.length) {
        const ph2 = toDelete.map(() => '?').join(',')
        await db.query(`UPDATE photos SET invoice_item_id = NULL WHERE invoice_item_id IN (${ph2})`, toDelete)
        await db.query(`DELETE FROM invoice_items WHERE id IN (${ph2})`, toDelete)
      }

      for (let i = 0; i < normItems.length; i++) {
        const item      = normItems[i]
        const existingId = resolvedIds[i]
        const lineTotal  = Math.round(Number(item.qty) * Number(item.unitPrice) * 100) / 100
        if (existingId) {
          await db.query(
            `UPDATE invoice_items SET description=?, type=?, hours=?, qty=?, unit_price=?, line_total=?, sort_order=? WHERE id=? AND invoice_id=?`,
            [item.description, item.type, item.hours, item.qty, item.unitPrice, lineTotal, item.sortOrder, existingId, id],
          )
        } else {
          await db.query(
            `INSERT INTO invoice_items (invoice_id, description, type, hours, qty, unit_price, line_total, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, item.description, item.type, item.hours, item.qty, item.unitPrice, lineTotal, item.sortOrder],
          )
        }
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
