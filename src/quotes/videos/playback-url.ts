import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { generatePlaybackUrl } from '../../shared/r2'
import { loadEditableQuote, QUOTE_VIDEO_LIMITS } from './_helpers'

const ready = bootstrap()

// GET /quotes/{id}/videos/{videoId}/playback-url
//
// Returns a fresh presigned playback URL. The URL baked into each video
// asset in the parent quote response is valid for 15 min; call this to
// refresh before it expires (or on <video> error). Same pattern as
// voice-notes.
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

    const [[row]] = await db.query<any[]>(
      `SELECT id, r2_key FROM video_assets
       WHERE id = ? AND context_type = 'quote' AND context_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [videoId, quoteId],
    )
    if (!row) return notFound('Video')

    const { playbackUrl, expiresAt } = await generatePlaybackUrl(String(row.r2_key), QUOTE_VIDEO_LIMITS.PLAYBACK_TTL)
    return ok({ playbackUrl, expiresAt })
  } catch (err) {
    return serverError(err)
  }
}
