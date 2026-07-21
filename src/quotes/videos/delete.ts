import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { deleteObject } from '../../shared/r2'
import { loadEditableQuote } from './_helpers'

const ready = bootstrap()

// DELETE /quotes/{id}/videos/{videoId}
//
// Soft-delete the row + hard-delete R2 object if the quote is still
// `draft` (nothing customer-facing has seen it). For `sent` quotes the
// R2 object stays for audit — the row's deleted_at hides it from all
// subsequent responses. Same pattern as voice-notes.
//
// `approved` / `declined` / `paid` etc. return 409 QUOTE_LOCKED —
// videos on closed quotes are part of the audit trail.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  const videoId = Number(event.pathParameters?.videoId)
  if (!quoteId || !videoId) return validationError('quote id and video id are required.')

  try {
    const allowedStoreIds = ctx.role === 'super_admin' ? null : await getAllowedStoreIds(db, ctx.staffId)
    const quote = await loadEditableQuote(db, quoteId, ctx.staffId, ctx.role, allowedStoreIds)
    if (!quote) return notFound('Quote')

    if (quote.status !== 'draft' && quote.status !== 'sent') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'QUOTE_LOCKED', message: 'Videos on closed quotes cannot be removed — they are part of the audit trail.' } }),
      }
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, r2_key, thumbnail_r2_key FROM video_assets
       WHERE id = ? AND context_type = 'quote' AND context_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [videoId, quoteId],
    )
    if (!row) return notFound('Video')

    await db.query(
      'UPDATE video_assets SET deleted_at = NOW() WHERE id = ?',
      [videoId],
    )

    // Hard-delete R2 objects only when the quote is still draft — sent
    // quotes may have been shown to the customer, and we keep the audit
    // trail even after soft-delete.
    if (quote.status === 'draft') {
      await deleteObject(String(row.r2_key)).catch(err =>
        console.warn('[quote-videos] R2 delete failed (non-fatal):', row.r2_key, err),
      )
      if (row.thumbnail_r2_key) {
        await deleteObject(String(row.thumbnail_r2_key)).catch(err =>
          console.warn('[quote-videos] Thumbnail delete failed (non-fatal):', row.thumbnail_r2_key, err),
        )
      }
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
