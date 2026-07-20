import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { deleteVoiceNoteObject, loadEditableQuote } from './_helpers'

const ready = bootstrap()

// DELETE /quotes/{id}/voice-notes/{noteId}
//
// Soft-deletes the note from the DB (deleted_at = NOW()). If the quote is
// still `draft` we also hard-delete the S3 object — nothing customer-facing
// has heard it. If the quote is `sent`, the customer may have already
// listened, so we keep the S3 object for audit but hide the row from all
// subsequent responses.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  const noteId  = Number(event.pathParameters?.noteId)
  if (!quoteId || !noteId) return validationError('quote id and note id are required.')

  try {
    const allowedStoreIds = ctx.role === 'super_admin' ? null : await getAllowedStoreIds(db, ctx.staffId)
    const quote = await loadEditableQuote(db, quoteId, ctx.staffId, ctx.role, allowedStoreIds)
    if (!quote) return notFound('Quote')

    const [[note]] = await db.query<any[]>(
      'SELECT id, s3_key FROM quote_voice_notes WHERE id = ? AND quote_id = ? AND deleted_at IS NULL LIMIT 1',
      [noteId, quoteId],
    )
    if (!note) return notFound('Voice note')

    await db.query(
      'UPDATE quote_voice_notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
      [noteId],
    )

    // Hard-delete S3 only for drafts. Customers of sent quotes may have
    // already played the audio — keep it around for audit.
    if (quote.status === 'draft') {
      await deleteVoiceNoteObject(String(note.s3_key))
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
