import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { writeToDataLake } from '../shared/dataLake'

const ready = bootstrap()

const IDLE_DAYS_THRESHOLD = Number(process.env.SESSION_ARCHIVE_IDLE_DAYS ?? '30')
const BATCH_SIZE          = Number(process.env.SESSION_ARCHIVE_BATCH_SIZE ?? '100')

// Runs on a daily EventBridge schedule. Finds chat sessions that have been
// idle > IDLE_DAYS_THRESHOLD days, archives each to S3 as diagnostic-sessions,
// then deletes the MySQL rows. Sessions <30 days stay in MySQL where the reply
// loop can fetch them fast; older ones move to S3 for long-term storage and
// training corpus.
export const handler = async (): Promise<{ archived: number; failed: number; skipped: number }> => {
  await ready
  const db = getPool()

  const [sessions] = await db.query<any[]>(
    `SELECT id, vehicle_id, customer_id, title, created_at, updated_at
     FROM customer_chat_sessions
     WHERE updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY updated_at ASC
     LIMIT ?`,
    [IDLE_DAYS_THRESHOLD, BATCH_SIZE],
  )

  console.log(`[archive] found ${sessions.length} idle sessions (>${IDLE_DAYS_THRESHOLD}d)`)

  let archived = 0
  let failed   = 0
  let skipped  = 0

  for (const session of sessions) {
    try {
      const [messages] = await db.query<any[]>(
        `SELECT id, role, content, image_id, tool_calls, created_at
         FROM customer_vehicle_chats WHERE session_id = ? ORDER BY id ASC`,
        [session.id],
      )

      if (messages.length === 0) {
        // Empty session — no point archiving, just delete.
        await db.query('DELETE FROM customer_chat_sessions WHERE id = ?', [session.id])
        skipped++
        continue
      }

      const startedAt = session.created_at instanceof Date ? session.created_at.toISOString() : String(session.created_at)
      const firstUser = messages.find((m: any) => m.role === 'user')?.content ?? null
      const title     = session.title ?? (firstUser ? String(firstUser).slice(0, 100) : 'chat session')

      const s3Result = await writeToDataLake('diagnostic-sessions', {
        vehicleId:    session.vehicle_id,
        customerId:   session.customer_id,
        sessionId:    session.id,
        title,
        startedAt,
        closedAt:     new Date().toISOString(),
        messageCount: messages.length,
        summary:      title,
        archivedBy:   'nightly-idle-job',
        messages:     messages.map((m: any) => ({
          role:      m.role,
          content:   m.content,
          imageId:   m.image_id ?? null,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
          createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
        })),
      })

      if (!s3Result) {
        // S3 write failed — leave the session in MySQL, don't delete rows.
        failed++
        console.error(`[archive] S3 write failed for session ${session.id}, keeping MySQL row`)
        continue
      }

      await db.query(
        `INSERT INTO s3_event_index (vehicle_id, customer_id, event_type, s3_key, event_date, summary)
         VALUES (?, ?, 'diagnostic-sessions', ?, ?, ?)`,
        [session.vehicle_id, session.customer_id, s3Result.key, startedAt, s3Result.summary],
      )

      // Only drop MySQL rows after S3 + index both succeeded.
      await db.query('DELETE FROM customer_vehicle_chats WHERE session_id = ?', [session.id])
      await db.query('DELETE FROM customer_chat_sessions WHERE id = ?', [session.id])

      archived++
    } catch (err) {
      failed++
      console.error(`[archive] session ${session.id} error:`, (err as Error).message)
    }
  }

  const result = { archived, failed, skipped }
  console.log(`[archive] done`, result)
  return result
}
