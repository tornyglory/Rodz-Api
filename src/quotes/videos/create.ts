import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { isSupportedVideoContentType, objectExists } from '../../shared/r2'
import { loadEditableQuote, toVideoAssetResponse, QUOTE_VIDEO_LIMITS } from './_helpers'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /quotes/{id}/videos
// Body: { r2Key, contentType, durationSeconds, sizeBytes?, quoteItemId? }
//
// Records a completed video upload against the quote or a specific line
// item. Kicks off the async post-process Lambda (thumbnail + verify)
// fire-and-forget — caller gets the row back immediately with a live
// playback URL and process_status: 'pending'. When post-process completes,
// subsequent GETs return the thumbnail URL and verified dimensions.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  if (!quoteId) return validationError('quote id is required.')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const r2Key           = typeof body.r2Key === 'string' ? body.r2Key.trim() : ''
    const contentType     = typeof body.contentType === 'string' ? body.contentType.trim() : ''
    const durationSeconds = Number(body.durationSeconds)
    const sizeBytes       = body.sizeBytes != null ? Number(body.sizeBytes) : null
    const quoteItemId     = body.quoteItemId != null ? Number(body.quoteItemId) : null

    if (!r2Key) return validationError('r2Key is required.')
    if (!r2Key.startsWith(`quote-clips/${quoteId}/`)) {
      return validationError('r2Key does not belong to this quote.')
    }
    if (!contentType || !isSupportedVideoContentType(contentType)) {
      return validationError('contentType must be a supported video type.')
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return validationError('durationSeconds must be a positive number.')
    }
    if (durationSeconds > QUOTE_VIDEO_LIMITS.MAX_DURATION_SEC) {
      return validationError(`durationSeconds must not exceed ${QUOTE_VIDEO_LIMITS.MAX_DURATION_SEC}.`)
    }
    if (sizeBytes != null && sizeBytes > QUOTE_VIDEO_LIMITS.MAX_UPLOAD_BYTES) {
      return validationError('sizeBytes exceeds max upload size.')
    }

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

    // Guard: quoteItemId must belong to this quote.
    if (quoteItemId != null) {
      const [[item]] = await db.query<any[]>(
        'SELECT id FROM quote_items WHERE id = ? AND quote_id = ? LIMIT 1',
        [quoteItemId, quoteId],
      )
      if (!item) return validationError('quoteItemId does not belong to this quote.')
    }

    // Verify the R2 upload actually landed. Cheap range-request check.
    const exists = await objectExists(r2Key)
    if (!exists) {
      return validationError('r2Key not found in R2 — the upload may not have completed.')
    }

    const [insertResult] = await db.query<any>(
      `INSERT INTO video_assets
         (r2_key, content_type, duration_seconds, size_bytes,
          context_type, context_id, context_item_id,
          visibility, uploaded_by_staff_id, process_status)
       VALUES (?, ?, ?, ?, 'quote', ?, ?, 'shared_link', ?, 'pending')`,
      [r2Key, contentType, durationSeconds, sizeBytes,
       quoteId, quoteItemId, ctx.staffId || null],
    )
    const videoId = Number(insertResult.insertId)

    // Fire-and-forget post-process. Skip if ARN unset (e.g. before the
    // Lambda has been deployed) — the row stays 'pending' and can be
    // retried later via a follow-up endpoint if needed.
    const postProcessArn = process.env.QUOTE_VIDEO_POST_PROCESS_FN_ARN
    if (postProcessArn) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName:   postProcessArn,
          InvocationType: 'Event',
          Payload:        Buffer.from(JSON.stringify({ videoId })),
        }))
      } catch (invokeErr) {
        console.warn('[quote-videos] Failed to invoke post-process (non-fatal):', invokeErr)
      }
    }

    const [[row]] = await db.query<any[]>(
      `SELECT v.id, v.r2_key, v.content_type, v.duration_seconds, v.size_bytes,
              v.width, v.height, v.thumbnail_r2_key, v.process_status,
              v.visibility, v.context_id, v.context_item_id, v.created_at,
              CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS recorded_by_name
       FROM video_assets v
       LEFT JOIN staff s ON s.id = v.uploaded_by_staff_id
       WHERE v.id = ? LIMIT 1`,
      [videoId],
    )

    const response = await toVideoAssetResponse(row)
    return created(response)
  } catch (err) {
    return serverError(err)
  }
}
