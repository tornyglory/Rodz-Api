import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'
import { writeToDataLake } from '../../../shared/dataLake'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      'SELECT id, title, created_at FROM customer_chat_sessions WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    // Grab everything before deletion so we can archive to S3.
    const [messages] = await db.query<any[]>(
      `SELECT id, role, content, image_id, tool_calls, created_at
       FROM customer_vehicle_chats WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
    )

    const images = messages.filter((m: any) => m.image_id).map((m: any) => m.image_id)

    // Archive to S3 as a diagnostic-session document before deletion. Only if
    // the session has content — no point archiving empty ones.
    let s3Result: Awaited<ReturnType<typeof writeToDataLake>> = null
    if (messages.length > 0) {
      const startedAt = session.created_at instanceof Date ? session.created_at.toISOString() : String(session.created_at)
      const firstUserMessage = messages.find((m: any) => m.role === 'user')?.content ?? null
      const title = session.title ?? (firstUserMessage ? firstUserMessage.slice(0, 100) : 'chat session')

      s3Result = await writeToDataLake('diagnostic-sessions', {
        vehicleId,
        customerId:  ctx.customerId,
        sessionId,
        title,
        startedAt,
        closedAt:    new Date().toISOString(),
        messageCount: messages.length,
        summary:     title,
        messages:    messages.map((m: any) => ({
          role:      m.role,
          content:   m.content,
          imageId:   m.image_id ?? null,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
          createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
        })),
      })

      if (s3Result) {
        await db.query(
          `INSERT INTO s3_event_index (vehicle_id, customer_id, event_type, s3_key, event_date, summary)
           VALUES (?, ?, 'diagnostic-sessions', ?, ?, ?)`,
          [vehicleId, ctx.customerId, s3Result.key, startedAt, s3Result.summary],
        )
      }
    }

    await db.query('DELETE FROM customer_vehicle_chats WHERE session_id = ?', [sessionId])
    await db.query('DELETE FROM customer_chat_sessions WHERE id = ?', [sessionId])

    await Promise.allSettled(images.map((id: string) => deleteCloudflareImage(id)))

    return ok({ deleted: true, archived: s3Result != null })
  } catch (err) {
    return serverError(err)
  }
}
