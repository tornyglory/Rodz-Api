import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import crypto from 'crypto'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { invoiceError, INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, getAllowedStoreIds, upsertServiceLog } from './_helpers'
import { createZellerPayment } from '../shared/zeller'
import { sendInvoiceEmail } from '../shared/emailTemplates'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT i.*,
              c.email      AS cust_email,
              c.first_name AS cust_first,
              c.last_name  AS cust_last,
              vl.label     AS vehicle_label,
              s.name       AS store_name
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN stores s    ON s.id = i.store_id
       LEFT JOIN (
         SELECT rego, CONCAT(ANY_VALUE(year), ' ', ANY_VALUE(make), ' ', ANY_VALUE(model)) AS label
         FROM vehicles WHERE is_active = 1 GROUP BY rego
       ) vl ON vl.rego = i.vehicle_rego
       WHERE i.id = ? LIMIT 1`,
      [id],
    )
    if (!row) return notFound('Invoice')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return notFound('Invoice')
    }
    if (ctx.role === 'technician' && String(row.staff_id) !== String(ctx.staffId))
      return forbidden()

    if (row.status === 'paid')
      return invoiceError(409, 'ALREADY_PAID', 'Cannot resend a paid invoice.')

    const token = crypto.randomBytes(32).toString('hex')

    // Zeller payment — best-effort, non-fatal on failure
    let zellerPaymentId:  string | null = null
    let zellerPaymentUrl: string | null = null
    try {
      const frontendUrl = process.env.FRONTEND_URL ?? ''
      const redirectUrl = `${frontendUrl}/invoice/${token}?paid=true`
      const amountCents = Math.round(Number(row.total) * 100)
      const zeller = await createZellerPayment({
        amountCents,
        reference:   row.invoice_number,
        redirectUrl,
      })
      if (zeller) {
        zellerPaymentId  = zeller.id
        zellerPaymentUrl = zeller.paymentUrl
      }
    } catch (zellerErr) {
      console.error('Zeller payment creation failed (non-fatal):', zellerErr)
    }

    const dueDate = row.due_date
      ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    await db.query(
      `UPDATE invoices
       SET status = 'sent', token = ?, sent_at = NOW(), due_date = ?,
           zeller_payment_url = ?
       WHERE id = ?`,
      [token, dueDate, zellerPaymentUrl, id],
    )

    // Fetch line item descriptions for {{services}} substitution
    const [itemRows] = await db.query<any[]>(
      'SELECT description FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id',
      [id],
    )
    const services = itemRows.map((r: any) => r.description).join(', ')

    // Send invoice email — non-fatal
    const frontendUrl = process.env.FRONTEND_URL ?? ''
    await sendInvoiceEmail(db, {
      customerEmail: row.cust_email,
      customerName:  `${row.cust_first} ${row.cust_last}`,
      invoiceNumber: row.invoice_number,
      vehicle:       row.vehicle_label ?? row.vehicle_rego,
      rego:          row.vehicle_rego  ?? '',
      store:         (row.store_name  ?? '').replace(/^Rodz /, ''),
      services,
      total:         `$${Number(row.total).toFixed(2)}`,
      invoiceLink:   `${frontendUrl}/invoice/${token}`,
    })

    await upsertServiceLog(db, Number(id))

    // Async AI summary generation — fire and forget
    const summaryArn = process.env.SERVICE_SUMMARY_FN_ARN
    if (summaryArn) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName:   summaryArn,
          InvocationType: 'Event',
          Payload:        Buffer.from(JSON.stringify({ invoiceId: Number(id) })),
        }))
      } catch (summaryErr) {
        console.error('Failed to invoke ServiceSummaryEngine (non-fatal):', summaryErr)
      }
    }

    const [[updated]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [id])
    const itemsMap = await getInvoiceItems(db, [row.id])
    return ok({ invoice: buildInvoice(updated, itemsMap.get(row.id) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
