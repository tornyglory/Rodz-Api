import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'
import { QUOTE_SELECT, buildQuote, getQuoteItems } from './_helpers'
import { notifyStore } from '../shared/staffNotifications'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = event.pathParameters?.id

  try {
    const [result] = await db.query<any>(
      "UPDATE quotes SET status = 'approved', approved_at = NOW() WHERE id = ? AND status = 'sent'",
      [id],
    )
    if (result.affectedRows === 0) return notFound('Quote')

    const [[row]] = await db.query<any[]>(`${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`, [id])
    const quoteItems = await getQuoteItems(db, Number(id))
    const quote = buildQuote(row, quoteItems)

    await notifyStore(db, row.store_id, {
      type:    'quote_approved',
      title:   'Quote Approved',
      body:    `${quote.customerName} approved quote ${quote.quoteNumber}`,
      quoteId: Number(id),
    })

    return ok({ quote })
  } catch (err) {
    return serverError(err)
  }
}
