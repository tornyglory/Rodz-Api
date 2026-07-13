// Group customer_vehicle_chats by session_id and write one JSON blob per
// session to S3 at diagnostic-sessions/current/{sessionId}.json.
// Idempotent — safe to re-run. Does NOT delete MySQL rows.
import mysql from 'mysql2/promise'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const s3     = new S3Client({ region: 'ap-southeast-2' })
const BUCKET = 'rodz-data-lake'

const conn = await mysql.createConnection({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     Number(process.env.DB_PORT ?? 3306),
  ssl:      { rejectUnauthorized: true },
})

const [sessions] = await conn.query(
  'SELECT id, vehicle_id, customer_id, title, updated_at FROM customer_chat_sessions ORDER BY id ASC',
)
console.log(`found ${sessions.length} sessions to migrate`)

let migrated = 0
let empty    = 0

for (const s of sessions) {
  const [messages] = await conn.query(
    `SELECT id, role, content, image_id, tool_calls, created_at
     FROM customer_vehicle_chats
     WHERE session_id = ?
     ORDER BY id ASC`,
    [s.id],
  )

  if (messages.length === 0) { empty++; continue }

  const blob = {
    sessionId:  s.id,
    vehicleId:  s.vehicle_id,
    customerId: s.customer_id,
    updatedAt:  s.updated_at instanceof Date ? s.updated_at.toISOString() : String(s.updated_at),
    messages: messages.map(m => ({
      id:        `mysql-${m.id}`,
      role:      m.role,
      content:   m.content ?? null,
      imageId:   m.image_id ?? null,
      toolCalls: m.tool_calls == null ? null : (typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls),
      createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
    })),
  }

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         `diagnostic-sessions/current/${s.id}.json`,
    Body:        JSON.stringify(blob),
    ContentType: 'application/json',
  }))
  migrated++
  console.log(`  → session ${s.id}: ${messages.length} messages`)
}

console.log(`\nDone. migrated=${migrated} empty=${empty} (skipped)`)
await conn.end()
