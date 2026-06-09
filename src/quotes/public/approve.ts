import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { validationError, serverError } from '../../shared/errors'
import { QUOTE_SELECT, buildQuote, quoteError, getQuoteItems } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const token = event.pathParameters?.token

  if (!token) return quoteError(400, 'MISSING_TOKEN', 'Token is required.')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { items } = body

    if (!Array.isArray(items) || items.length === 0) {
      return validationError('items must be a non-empty array.')
    }

    // ── Fetch quote by token ───────────────────────────────────────────────
    const [[quote]] = await db.query<any[]>(
      'SELECT id, status FROM quotes WHERE token = ? LIMIT 1',
      [token],
    )
    if (!quote) return quoteError(404, 'QUOTE_NOT_FOUND', 'Quote not found.')

    if (quote.status !== 'sent') {
      return quoteError(409, 'ALREADY_PROCESSED', 'This quote has already been processed.')
    }

    // ── Validate item IDs belong to this quote ─────────────────────────────
    const [existingItems] = await db.query<any[]>(
      'SELECT id FROM quote_items WHERE quote_id = ?',
      [quote.id],
    )
    const validIds = new Set(existingItems.map((r: any) => r.id))

    for (const item of items) {
      if (!validIds.has(item.id)) {
        return validationError(`Item ID ${item.id} does not belong to this quote.`)
      }
    }

    // ── Update each item's is_accepted ─────────────────────────────────────
    for (const item of items) {
      await db.query(
        'UPDATE quote_items SET is_accepted = ? WHERE id = ? AND quote_id = ?',
        [item.approved ? 1 : 0, item.id, quote.id],
      )
    }

    // ── Mark quote as approved ─────────────────────────────────────────────
    await db.query(
      "UPDATE quotes SET status = 'approved', approved_at = NOW(), approval_method = 'email_link' WHERE id = ?",
      [quote.id],
    )

    // Move linked job back to open so the kanban badge appears
    await db.query(
      "UPDATE service_jobs SET status = 'open' WHERE quote_id = ? AND status = 'awaiting_approval'",
      [quote.id],
    )

    const [[row]] = await db.query<any[]>(
      `${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`,
      [quote.id],
    )
    const quoteItems = await getQuoteItems(db, quote.id)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote: buildQuote(row, quoteItems) }),
    }
  } catch (err) {
    return serverError(err)
  }
}
