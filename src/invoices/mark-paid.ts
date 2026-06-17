import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, validationError, serverError } from '../shared/errors'
import { invoiceError, INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[row]] = await db.query<any[]>(
      'SELECT id, store_id, status FROM invoices WHERE id = ? LIMIT 1',
      [id],
    )
    if (!row) return notFound('Invoice')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return notFound('Invoice')
    }

    if (row.status === 'paid')
      return invoiceError(409, 'ALREADY_PAID', 'Invoice is already paid.')

    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { paymentMethod } = body

    if (!paymentMethod || !['bank_transfer', 'zeller'].includes(paymentMethod))
      return validationError('paymentMethod must be "bank_transfer" or "zeller".')

    await db.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = ? WHERE id = ?`,
      [paymentMethod, id],
    )

    const [[updated]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [id])
    const itemsMap = await getInvoiceItems(db, [row.id])
    return ok({ invoice: buildInvoice(updated, itemsMap.get(row.id) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
