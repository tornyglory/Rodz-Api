import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { loadSession } from './messagesStore'

const ready = bootstrap()
const PAGE_SIZE = 50

// Loads a session's messages from the S3 session-blob. Pagination is
// against the blob's messages array — no MySQL involved beyond ownership +
// session metadata checks.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)
  const before    = event.queryStringParameters?.before ?? null

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      `SELECT id, title FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    const { blob } = await loadSession(sessionId)
    const all = blob?.messages ?? []

    // Pagination: `before` is the message id to page backward from. When
    // omitted, return the newest PAGE_SIZE messages. When provided, return
    // the PAGE_SIZE messages older than that id.
    let sliceEnd = all.length
    if (before) {
      const idx = all.findIndex(m => m.id === before)
      if (idx > 0) sliceEnd = idx
    }
    const sliceStart = Math.max(0, sliceEnd - PAGE_SIZE)
    const page       = all.slice(sliceStart, sliceEnd)
    const hasMore    = sliceStart > 0

    const messages = page.map(m => ({
      id:        m.id,
      role:      m.role,
      content:   m.content ?? null,
      imageUrl:  m.imageId ? imageUrls(m.imageId).public : null,
      createdAt: m.createdAt,
      hints:     [] as string[], // ephemeral UI cue, never persisted
    }))

    return ok({
      sessionId,
      title:           session.title ?? null,
      messages,
      hasMore,
      oldestMessageId: messages[0]?.id ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
