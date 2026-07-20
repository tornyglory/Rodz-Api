import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadSession } from './messagesStore'

const ready = bootstrap()

// PUT /c/vehicles/{id}/chats/{sessionId}/messages/{messageId}/feedback
//
// Body: { rating: 'up' | 'down' | null, reason?: string }
//
// Idempotent by design. Same customer thumbing the same message multiple
// times replaces their rating. Sending `rating: null` clears it (row is
// deleted). The message must belong to the session and must be an AI
// (`role='model'`) message — user messages aren't thumbable.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)
  const messageId = String(event.pathParameters?.messageId ?? '').trim()

  if (!vehicleId || !sessionId || !messageId) {
    return validationError('vehicleId, sessionId, and messageId are required.')
  }

  try {
    // Ownership guard — same as every other /c/vehicles/{id}/chats/* route.
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    // Session must exist, be owned by the caller, and not be soft-deleted.
    const [[session]] = await db.query<any[]>(
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    // Verify the message exists in this session's S3 blob and is an AI reply.
    // Only AI messages are thumbable — a customer thumbing their own message
    // is a UX bug we won't help propagate.
    const { blob } = await loadSession(sessionId)
    const msg = (blob?.messages ?? []).find(m => m.id === messageId)
    if (!msg) return notFound('Message')
    if (msg.role !== 'model') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'NOT_AI_MESSAGE', message: 'Only AI messages can be rated.' },
        }),
      }
    }

    const body   = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const rating = body.rating   // 'up' | 'down' | null
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null
    const promptVersion = typeof body.promptVersion === 'string' ? body.promptVersion.trim().slice(0, 40) : null

    if (rating === null) {
      // Clear — delete any existing row. Idempotent no-op if none.
      await db.query(
        `DELETE FROM chat_message_feedback WHERE customer_id = ? AND message_id = ?`,
        [ctx.customerId, messageId],
      )
      return ok({ rating: null })
    }

    if (rating !== 'up' && rating !== 'down') {
      return validationError("rating must be 'up', 'down', or null.")
    }

    // Upsert. UNIQUE (customer_id, message_id) guarantees at most one row.
    await db.query(
      `INSERT INTO chat_message_feedback
         (customer_id, vehicle_id, session_id, message_id, rating, reason, prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         rating         = VALUES(rating),
         reason         = VALUES(reason),
         prompt_version = COALESCE(VALUES(prompt_version), prompt_version)`,
      [ctx.customerId, vehicleId, sessionId, messageId, rating, reason, promptVersion],
    )

    return ok({
      rating,
      reason,
      messageId,
      sessionId,
    })
  } catch (err) {
    return serverError(err)
  }
}
