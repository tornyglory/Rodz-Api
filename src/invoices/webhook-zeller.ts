import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { verifyZellerSignature } from '../shared/zeller'
import { pushToCustomer } from '../shared/push'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const rawBody  = event.body ?? ''
  const sigHeader = event.headers['x-zeller-signature'] ?? event.headers['x-webhook-signature']

  if (!verifyZellerSignature(rawBody, sigHeader)) {
    console.warn('Zeller webhook: invalid signature')
    return { statusCode: 401, body: '' }
  }

  try {
    const payload = JSON.parse(rawBody) as any
    if (payload.event !== 'payment.completed') {
      return { statusCode: 200, body: '' }
    }

    const { id: zellerPaymentId, reference } = payload.data ?? {}

    // Look up invoice by Zeller payment ID or by invoice number reference
    const [[invoice]] = await db.query<any[]>(
      `SELECT id, status, customer_id, invoice_number, total FROM invoices
       WHERE (zeller_payment_id = ? OR invoice_number = ?) AND status != 'paid'
       LIMIT 1`,
      [zellerPaymentId ?? null, reference ?? null],
    )

    if (!invoice) {
      console.log('Zeller webhook: no matching unpaid invoice for', { zellerPaymentId, reference })
      return { statusCode: 200, body: '' }
    }

    await db.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'zeller' WHERE id = ?`,
      [invoice.id],
    )

    // Customer receipt push (non-fatal). Include ISO date in eventId so
    // paid → refunded → repaid cycles re-notify per transition.
    try {
      const paidStamp = new Date().toISOString().slice(0, 10)
      await pushToCustomer(db, Number(invoice.customer_id), {
        type:     'payment_received',
        title:    'Rodz',
        body:     `Thanks — payment received for invoice ${invoice.invoice_number} ($${Number(invoice.total).toFixed(0)}).`,
        deeplink: '/account/paperwork?filter=invoices',
        eventId:  `invoice:${invoice.id}:paid:${paidStamp}`,
      })
    } catch {
      // Non-fatal
    }

    console.log(`Zeller webhook: invoice ${invoice.id} marked paid`)
    return { statusCode: 200, body: '' }
  } catch (err) {
    console.error('Zeller webhook error:', err)
    return { statusCode: 500, body: '' }
  }
}
