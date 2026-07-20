import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import {
  buildVoiceNoteKey, generateUploadUrl,
  isSupportedAudioContentType, loadEditableQuote,
  VOICE_NOTE_LIMITS,
} from './_helpers'

const ready = bootstrap()

// GET /quotes/{id}/voice-notes/upload-url?contentType=audio/webm
//
// Returns a short-lived presigned S3 PUT URL and the s3Key the client will
// hand back on the follow-up POST. Voice notes can only be added while the
// quote is still editable (draft or sent) — closed quotes reject with 409.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  if (!quoteId) return validationError('quote id is required.')

  const contentType = String(event.queryStringParameters?.contentType ?? '').trim() || 'audio/webm'
  if (!isSupportedAudioContentType(contentType)) {
    return validationError('contentType must be one of: audio/webm, audio/mp4, audio/m4a, audio/mpeg, audio/ogg, audio/wav.')
  }

  try {
    const allowedStoreIds = ctx.role === 'super_admin' ? null : await getAllowedStoreIds(db, ctx.staffId)
    const quote = await loadEditableQuote(db, quoteId, ctx.staffId, ctx.role, allowedStoreIds)
    if (!quote) return notFound('Quote')

    if (quote.status !== 'draft' && quote.status !== 'sent') {
      return { statusCode: 409, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'QUOTE_LOCKED', message: 'Voice notes can only be added to draft or sent quotes.' } }) }
    }

    const s3Key = buildVoiceNoteKey(quoteId, contentType)
    const { uploadUrl, expiresIn } = await generateUploadUrl(s3Key, contentType)

    return ok({
      uploadUrl,
      s3Key,
      contentType,
      expiresIn,
      maxSizeBytes:   VOICE_NOTE_LIMITS.MAX_UPLOAD_BYTES,
      maxDurationSec: VOICE_NOTE_LIMITS.MAX_DURATION_SEC,
    })
  } catch (err) {
    if (ctx.role === 'super_admin') { /* store filter not applied */ }
    return serverError(err)
  }
}
