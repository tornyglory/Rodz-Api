import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { sendEmail } from '../shared/ses'
import { pushToCustomer } from '../shared/push'
import { QUOTE_SELECT, buildQuote, quoteError, getAllowedStoreIds, getQuoteItems } from './_helpers'
import { attachVoiceNotesToQuote } from './voice-notes/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    // ── Fetch quote ────────────────────────────────────────────────────────
    const [[quote]] = await db.query<any[]>(
      `SELECT q.id, q.store_id, q.status, q.customer_id,
              CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
              c.first_name AS customer_first_name,
              c.email AS customer_email,
              v.rego AS vehicle_rego,
              CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
              s.name AS store_name,
              q.quote_number
       FROM quotes q
       JOIN customers c ON c.id = q.customer_id
       JOIN stores s    ON s.id = q.store_id
       LEFT JOIN vehicles v ON v.id = q.vehicle_id
       WHERE q.id = ? LIMIT 1`,
      [id],
    )
    if (!quote) return quoteError(404, 'QUOTE_NOT_FOUND', 'Quote not found.')

    // ── Only draft or sent quotes can be (re)sent ──────────────────────────
    if (quote.status !== 'draft' && quote.status !== 'sent') {
      return quoteError(409, 'QUOTE_NOT_SENDABLE', 'Only draft or sent quotes can be sent.')
    }

    // ── Store access check ─────────────────────────────────────────────────
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(quote.store_id)) return forbidden()
    }

    // ── Generate token & update quote ──────────────────────────────────────
    const token = crypto.randomUUID()

    await db.query(
      "UPDATE quote_items SET is_accepted = NULL WHERE quote_id = ?",
      [id],
    )

    await db.query(
      "UPDATE quotes SET token = ?, status = 'sent', sent_at = NOW() WHERE id = ?",
      [token, id],
    )

    // ── Send email (non-fatal) ─────────────────────────────────────────────
    try {
      const [[settingsRow]] = await db.query<any[]>('SELECT settings FROM email_settings LIMIT 1')
      if (settingsRow) {
        const settings = typeof settingsRow.settings === 'string'
          ? JSON.parse(settingsRow.settings)
          : settingsRow.settings

        if (settings?.quoteTemplate && settings.fromAddress && quote.customer_email) {
          const approvalLink = `${process.env.FRONTEND_URL ?? ''}/q/${token}`
          const storeName = (quote.store_name ?? '').replace(/^Rodz /, '')

          await sendEmail({
            to:          quote.customer_email,
            subject:     settings.quoteTemplate.subject,
            body:        settings.quoteTemplate.body,
            fromAddress: settings.fromAddress,
            replyTo:     settings.replyTo || undefined,
            variables: {
              customerName:  quote.customer_name   ?? '',
              firstName:     quote.customer_first_name ?? String(quote.customer_name ?? '').split(' ')[0],
              vehicle:       quote.vehicle_label   ?? '',
              rego:          quote.vehicle_rego    ?? '',
              store:         storeName,
              quoteNumber:   quote.quote_number    ?? '',
              approvalLink,
            },
          })
        }
      }
    } catch {
      // Email failure is non-fatal
    }

    // ── Push notification (non-fatal) ──────────────────────────────────────
    // Customer gets a wake-up alert on their phone. Deep-links into the
    // paperwork list filtered to quotes.
    try {
      await pushToCustomer(db, Number(quote.customer_id), {
        type:     'quote_ready',
        title:    'Rodz',
        body:     `New quote ready for your ${quote.vehicle_label ?? 'vehicle'} — ${quote.quote_number}.`,
        deeplink: '/account/paperwork?filter=quotes',
        eventId:  `quote:${quote.id}`,
      })
    } catch {
      // Push failure is non-fatal
    }

    const [[row]] = await db.query<any[]>(`${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`, [id])
    const items = await getQuoteItems(db, Number(id))
    const built = buildQuote(row, items)
    await attachVoiceNotesToQuote(db, built)
    return ok({ quote: built })
  } catch (err) {
    return serverError(err)
  }
}
