import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { notFound, serverError } from '../shared/errors'
import { INVOICE_SELECT, buildInvoice, getInvoiceItems } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[row]] = await db.query<any[]>(
      `${INVOICE_SELECT} WHERE i.token = ? LIMIT 1`,
      [token],
    )
    if (!row) return notFound('Invoice')

    const itemsMap = await getInvoiceItems(db, [row.id])
    const invoice  = buildInvoice(row, itemsMap.get(row.id) ?? [])

    // Fetch bank details — never 404
    const [[settings]] = await db.query<any[]>(
      'SELECT bank_account_name, bank_bsb, bank_account_number, bank_reference FROM business_settings WHERE id = 1 LIMIT 1',
    )
    const bankDetails = settings
      ? {
          accountName:   settings.bank_account_name,
          bsb:           settings.bank_bsb,
          accountNumber: settings.bank_account_number,
          reference:     `${settings.bank_reference}${invoice.invoiceNumber}`,
        }
      : { accountName: '', bsb: '', accountNumber: '', reference: '' }

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ invoice, bankDetails }),
    }
  } catch (err) {
    return serverError(err)
  }
}
