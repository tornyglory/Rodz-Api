import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { generatePlaybackUrl } from './_helpers'

const ready = bootstrap()

// GET /quotes/{id}/voice-notes/{noteId}/playback-url
//
// Refreshes a short-lived playback URL when the one baked into a quote
// response has expired. Same auth as the parent quote — if the staff
// caller can see the quote, they can get a fresh URL.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  const noteId  = Number(event.pathParameters?.noteId)
  if (!quoteId || !noteId) return validationError('quote id and note id are required.')

  try {
    const [[quote]] = await db.query<any[]>(
      'SELECT id, store_id, prepared_by_staff_id FROM quotes WHERE id = ? LIMIT 1',
      [quoteId],
    )
    if (!quote) return notFound('Quote')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(Number(quote.store_id))) return notFound('Quote')
      if (ctx.role === 'technician' && String(quote.prepared_by_staff_id) !== String(ctx.staffId)) {
        return notFound('Quote')
      }
    }

    const [[note]] = await db.query<any[]>(
      'SELECT s3_key FROM quote_voice_notes WHERE id = ? AND quote_id = ? AND deleted_at IS NULL LIMIT 1',
      [noteId, quoteId],
    )
    if (!note) return notFound('Voice note')

    const { playbackUrl, expiresAt } = await generatePlaybackUrl(String(note.s3_key))
    return ok({ playbackUrl, expiresAt })
  } catch (err) {
    return serverError(err)
  }
}
