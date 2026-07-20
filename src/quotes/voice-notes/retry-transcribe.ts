import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../_helpers'
import { loadEditableQuote } from './_helpers'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /quotes/{id}/voice-notes/{noteId}/retry-transcribe
//
// Staff-only. Flips the row back to 'pending' and re-invokes the async
// transcription Lambda. Useful when the first pass failed (e.g. Gemini
// was down) or produced garbage.
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
      'SELECT id FROM quote_voice_notes WHERE id = ? AND quote_id = ? AND deleted_at IS NULL LIMIT 1',
      [noteId, quoteId],
    )
    if (!note) return notFound('Voice note')

    await db.query(
      `UPDATE quote_voice_notes SET transcript_status = 'pending', transcript = NULL WHERE id = ?`,
      [noteId],
    )

    const arn = process.env.QUOTE_VOICE_TRANSCRIBE_FN_ARN
    if (arn) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName:   arn,
          InvocationType: 'Event',
          Payload:        Buffer.from(JSON.stringify({ noteId })),
        }))
      } catch (invokeErr) {
        console.warn('[voice-notes] retry invoke failed (non-fatal):', invokeErr)
      }
    }

    return ok({ ok: true, transcriptStatus: 'pending' })
  } catch (err) {
    return serverError(err)
  }
}
