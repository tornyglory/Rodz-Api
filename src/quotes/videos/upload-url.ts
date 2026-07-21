import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { buildVideoKey, generateUploadUrl, isSupportedVideoContentType } from '../../shared/r2'
import { loadEditableQuote, QUOTE_VIDEO_LIMITS } from './_helpers'

const ready = bootstrap()

// GET /quotes/{id}/videos/upload-url?contentType=video/mp4
//
// Returns a short-lived R2 presigned PUT URL and the r2Key the client
// hands back on the follow-up POST. Same shape as voice notes.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  if (!quoteId) return validationError('quote id is required.')

  const contentType = String(event.queryStringParameters?.contentType ?? '').trim() || 'video/mp4'
  if (!isSupportedVideoContentType(contentType)) {
    return validationError('contentType must be one of: video/mp4, video/webm, video/quicktime.')
  }

  try {
    const allowedStoreIds = ctx.role === 'super_admin' ? null : await getAllowedStoreIds(db, ctx.staffId)
    const quote = await loadEditableQuote(db, quoteId, ctx.staffId, ctx.role, allowedStoreIds)
    if (!quote) return notFound('Quote')

    if (quote.status !== 'draft' && quote.status !== 'sent') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'QUOTE_LOCKED', message: 'Videos can only be added to draft or sent quotes.' } }),
      }
    }

    const r2Key = buildVideoKey('quote-clips', quoteId, contentType)
    const { uploadUrl, expiresIn } = await generateUploadUrl(r2Key, contentType, QUOTE_VIDEO_LIMITS.UPLOAD_TTL)

    return ok({
      uploadUrl,
      r2Key,
      contentType,
      expiresIn,
      maxSizeBytes:   QUOTE_VIDEO_LIMITS.MAX_UPLOAD_BYTES,
      maxDurationSec: QUOTE_VIDEO_LIMITS.MAX_DURATION_SEC,
    })
  } catch (err) {
    return serverError(err)
  }
}
