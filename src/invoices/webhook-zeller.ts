import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { verifyZellerSignature } from '../shared/zeller'

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
      `SELECT id, status FROM invoices
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

    console.log(`Zeller webhook: invoice ${invoice.id} marked paid`)
    return { statusCode: 200, body: '' }
  } catch (err) {
    console.error('Zeller webhook error:', err)
    return { statusCode: 500, body: '' }
  }
}
