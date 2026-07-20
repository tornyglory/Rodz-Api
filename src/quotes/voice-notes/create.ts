import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import {
  loadEditableQuote, isSupportedAudioContentType, toVoiceNoteResponse,
  VOICE_NOTE_LIMITS,
} from './_helpers'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /quotes/{id}/voice-notes
// Body: { s3Key, contentType, durationSeconds, sizeBytes?, quoteItemId? }
//
// Records a completed voice-note upload against the quote or a specific line
// item. Kicks off the async transcription Lambda fire-and-forget — the
// caller gets the row back immediately with a live playback URL and
// transcript_status: 'pending'. When transcription completes, subsequent
// GETs return the transcript.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const quoteId = Number(event.pathParameters?.id)
  if (!quoteId) return validationError('quote id is required.')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const s3Key           = typeof body.s3Key === 'string' ? body.s3Key.trim() : ''
    const contentType     = typeof body.contentType === 'string' ? body.contentType.trim() : ''
    const durationSeconds = Number(body.durationSeconds)
    const sizeBytes       = body.sizeBytes != null ? Number(body.sizeBytes) : null
    const quoteItemId     = body.quoteItemId != null ? Number(body.quoteItemId) : null

    if (!s3Key) return validationError('s3Key is required.')
    if (!s3Key.startsWith(`quote-voice-notes/${quoteId}/`)) {
      return validationError('s3Key does not belong to this quote.')
    }
    if (!contentType || !isSupportedAudioContentType(contentType)) {
      return validationError('contentType must be a supported audio type.')
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return validationError('durationSeconds must be a positive number.')
    }
    if (durationSeconds > VOICE_NOTE_LIMITS.MAX_DURATION_SEC) {
      return validationError(`durationSeconds must not exceed ${VOICE_NOTE_LIMITS.MAX_DURATION_SEC}.`)
    }
    if (sizeBytes != null && sizeBytes > VOICE_NOTE_LIMITS.MAX_UPLOAD_BYTES) {
      return validationError('sizeBytes exceeds max upload size.')
    }

    const allowedStoreIds = ctx.role === 'super_admin' ? null : await getAllowedStoreIds(db, ctx.staffId)
    const quote = await loadEditableQuote(db, quoteId, ctx.staffId, ctx.role, allowedStoreIds)
    if (!quote) return notFound('Quote')

    if (quote.status !== 'draft' && quote.status !== 'sent') {
      return { statusCode: 409, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'QUOTE_LOCKED', message: 'Voice notes can only be added to draft or sent quotes.' } }) }
    }

    // Guard: quoteItemId must belong to this quote.
    if (quoteItemId != null) {
      const [[item]] = await db.query<any[]>(
        'SELECT id FROM quote_items WHERE id = ? AND quote_id = ? LIMIT 1',
        [quoteItemId, quoteId],
      )
      if (!item) return validationError('quoteItemId does not belong to this quote.')
    }

    const [insertResult] = await db.query<any>(
      `INSERT INTO quote_voice_notes
         (quote_id, quote_item_id, s3_key, content_type, duration_seconds,
          size_bytes, recorded_by_staff_id, transcript_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [quoteId, quoteItemId, s3Key, contentType, durationSeconds, sizeBytes, ctx.staffId || null],
    )
    const noteId = Number(insertResult.insertId)

    // Fire-and-forget transcription. If the ARN is unset (e.g. before the
    // transcription Lambda has been deployed), we silently skip — the row
    // stays 'pending' and can be retried via the retry endpoint later.
    const transcribeArn = process.env.QUOTE_VOICE_TRANSCRIBE_FN_ARN
    if (transcribeArn) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName:   transcribeArn,
          InvocationType: 'Event',
          Payload:        Buffer.from(JSON.stringify({ noteId })),
        }))
      } catch (invokeErr) {
        console.warn('[voice-notes] Failed to invoke transcription (non-fatal):', invokeErr)
      }
    }

    const [[row]] = await db.query<any[]>(
      `SELECT v.id, v.quote_id, v.quote_item_id, v.s3_key, v.content_type,
              v.duration_seconds, v.size_bytes, v.transcript, v.transcript_status,
              v.created_at,
              CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS recorded_by_name
       FROM quote_voice_notes v
       LEFT JOIN staff s ON s.id = v.recorded_by_staff_id
       WHERE v.id = ? LIMIT 1`,
      [noteId],
    )

    const response = await toVoiceNoteResponse(row)
    return created(response)
  } catch (err) {
    return serverError(err)
  }
}
