import type mysql from 'mysql2/promise'
import { safeDel } from '../../../shared/redis'

// ── Hint extraction (UI spotlighting cues) ─────────────────────────────────

export const VALID_HINTS = new Set([
  'chat', 'logbook', 'maintenance', 'profile',
  'photos', 'expenses', 'share', 'settings',
])

const HINT_LINE_RE = /^\s*\[HINTS:\s*([^\]]+)\]\s*$/im

export function extractHints(raw: string): { content: string; hints: string[] } {
  if (!raw) return { content: '', hints: [] }
  const match = raw.match(HINT_LINE_RE)
  if (!match) return { content: raw, hints: [] }

  const seen = new Set<string>()
  const hints: string[] = []
  for (const s of match[1].split(',')) {
    const h = s.trim().toLowerCase()
    if (VALID_HINTS.has(h) && !seen.has(h)) {
      seen.add(h)
      hints.push(h)
      if (hints.length >= 2) break
    }
  }
  const content = raw.replace(HINT_LINE_RE, '').trimEnd()
  return { content, hints }
}

export function isHintsEnabled(): boolean {
  return process.env.CHAT_HINTS_ENABLED === 'true'
}

export const HINTS_INSTRUCTION = `
When your reply refers to a specific feature the customer can navigate to in the app, add a hint line at the END of your reply, on its own line, in this exact format:

[HINTS: <comma-separated feature keys>]

Feature keys are drawn ONLY from this list:
  chat, logbook, maintenance, profile, photos, expenses, share, settings

Rules:
- Only include a feature you actually referenced in prose.
- At most 2 features per reply. Usually 1 or 0.
- Never invent new keys. If a feature doesn't match the list, don't emit it.
- Don't mention the hints line itself — it's a machine marker the app parses out.
- If no features are referenced, omit the line entirely.

Feature mapping:
  chat        → the Rodz Assistant (this chat) — rarely used
  logbook     → digital logbook, service history, past services, invoice import
  maintenance → maintenance schedule, upcoming services, service intervals
  profile     → vehicle profile, specs, description, cover/avatar
  photos      → photo gallery
  expenses    → Expense Tracker (receipts, fuel, cost of ownership)
  share       → shareable public link
  settings    → privacy, ownership transfer, delete

Example:
  "You've got a service due in about 2,000 km. Have a look at your Maintenance tab for the full schedule."
  [HINTS: maintenance]
`


// ── Assistant memory (per-vehicle scratchpad) ──────────────────────────────

export interface MemoryNote {
  id:             number
  note:           string
  createdDaysAgo: number
}

const MEMORY_LIMIT_PER_VEHICLE = 20
const DEFAULT_TTL_DAYS         = 180
const NOTE_MAX_CHARS           = 500

export function isMemoryEnabled(): boolean {
  return process.env.ASSISTANT_CONTEXT_ENABLED === 'true'
}

export async function getAssistantMemory(db: mysql.Pool, vehicleId: number): Promise<MemoryNote[]> {
  if (!isMemoryEnabled()) return []
  const [rows] = await db.query<any[]>(
    `SELECT id, note, DATEDIFF(NOW(), created_at) AS days_ago
     FROM assistant_memory
     WHERE vehicle_id = ?
       AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT ?`,
    [vehicleId, MEMORY_LIMIT_PER_VEHICLE],
  )
  return rows.map(r => ({ id: Number(r.id), note: String(r.note), createdDaysAgo: Number(r.days_ago) }))
}

export async function saveAssistantMemory(
  db:            mysql.Pool,
  vehicleId:     number,
  note:          string,
  expiresInDays: number = DEFAULT_TTL_DAYS,
): Promise<{ ok: true; noteId: number } | { ok: false; error: string }> {
  if (!isMemoryEnabled()) return { ok: false, error: 'memory disabled' }
  const trimmed = String(note ?? '').trim().slice(0, NOTE_MAX_CHARS)
  if (!trimmed) return { ok: false, error: 'empty note' }

  const ttl = Math.max(1, Math.min(Number(expiresInDays) || DEFAULT_TTL_DAYS, 365 * 2))

  // Cap active notes per vehicle at MEMORY_LIMIT_PER_VEHICLE — soft-delete the oldest.
  const [countRow] = await db.query<any[]>(
    `SELECT COUNT(*) AS n FROM assistant_memory
     WHERE vehicle_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [vehicleId],
  )
  const active = Number((countRow as any[])[0]?.n ?? 0)
  if (active >= MEMORY_LIMIT_PER_VEHICLE) {
    await db.query(
      `UPDATE assistant_memory SET deleted_at = NOW()
       WHERE vehicle_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC LIMIT ?`,
      [vehicleId, active - MEMORY_LIMIT_PER_VEHICLE + 1],
    )
  }

  const [result] = await db.query<any>(
    `INSERT INTO assistant_memory (vehicle_id, note, source, expires_at)
     VALUES (?, ?, 'assistant', DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [vehicleId, trimmed, ttl],
  )
  await safeDel(`vehicle:${vehicleId}:context`)
  return { ok: true, noteId: Number(result.insertId) }
}

export async function forgetAssistantMemory(
  db:        mysql.Pool,
  vehicleId: number,
  noteId:    number,
): Promise<{ ok: boolean }> {
  if (!isMemoryEnabled()) return { ok: false }
  const [result] = await db.query<any>(
    'UPDATE assistant_memory SET deleted_at = NOW() WHERE id = ? AND vehicle_id = ? AND deleted_at IS NULL',
    [noteId, vehicleId],
  )
  if (result.affectedRows > 0) await safeDel(`vehicle:${vehicleId}:context`)
  return { ok: result.affectedRows > 0 }
}

export function renderMemoryBlock(memory: MemoryNote[]): string {
  if (!memory.length) return ''
  return [
    '',
    '--- What you remember about this vehicle ---',
    JSON.stringify(memory, null, 2),
    '',
    'If any of these are relevant to the current turn, reference them naturally.',
    "Don't recite the list — weave them in only when they matter.",
  ].join('\n')
}

// ── Situation snapshot (greeting endpoint) ─────────────────────────────────

export interface SituationSnapshot {
  firstName:              string | null
  vehicleShort:           string
  odometerKm:             number | null
  nextServiceDueKm:       number | null
  nextServiceDueDate:     string | null
  regoExpiry:             string | null   // only if within 90 days
  mostRecentServiceDate:  string | null
  mostRecentServiceStore: string | null
  unreadRecommendations:  number
  // All active memory notes with recency — used to prompt specific callbacks
  // ("did that clicking clear up?" / "still planning to sell before Xmas?").
  memoryNotes:            { note: string; createdDaysAgo: number }[]
  // Prior chat sessions — lets the greeting say "welcome back" and reference
  // last topic. lastSessionTopic is the title of the most recent prior
  // session (null if never chatted before or title not yet generated).
  priorSessionCount:      number
  lastSessionTopic:       string | null
  lastSessionEndedDaysAgo: number | null
}

function toIsoDate(v: any): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export async function buildSituationSnapshot(
  db:         mysql.Pool,
  vehicleId:  number,
  customerId: number,
): Promise<SituationSnapshot | null> {
  const [[v]] = await db.query<any[]>(
    `SELECT v.rego, v.make, v.model, v.year,
            v.odometer_current, v.next_service_due_km, v.next_service_due_date, v.rego_expiry
     FROM vehicles v WHERE v.id = ? AND v.is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return null

  const [[customer]] = await db.query<any[]>(
    'SELECT first_name FROM customers WHERE id = ? LIMIT 1',
    [customerId],
  )

  const [[recent]] = await db.query<any[]>(
    `SELECT service_date, store FROM vehicle_service_log
     WHERE vehicle_rego = ? ORDER BY service_date DESC LIMIT 1`,
    [v.rego],
  )

  const [[recCount]] = await db.query<any[]>(
    `SELECT COUNT(*) AS n FROM ai_recommendations
     WHERE vehicle_id = ? AND status IN ('active', 'sent')`,
    [vehicleId],
  )

  // Rego expiry only if within 90 days (matches brief).
  const rego = toIsoDate(v.rego_expiry)
  let regoExpiry: string | null = null
  if (rego) {
    const daysUntil = Math.round((new Date(rego).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (daysUntil <= 90) regoExpiry = rego
  }

  const memory = await getAssistantMemory(db, vehicleId)
  const memoryNotes = memory.slice(0, 5).map(m => ({ note: m.note, createdDaysAgo: m.createdDaysAgo }))

  // Prior sessions — for "welcome back" openers and last-topic callbacks.
  // Excludes the current session (which is empty at greeting time).
  const [prior] = await db.query<any[]>(
    `SELECT title, updated_at
     FROM customer_chat_sessions
     WHERE vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 20`,
    [vehicleId, customerId],
  )
  // Filter out any session with no messages (like the just-created one).
  // A session with a title is guaranteed to have had a first user message.
  const withTitle = (prior as any[]).filter(s => s.title)
  const priorSessionCount = withTitle.length
  const last = withTitle[0]
  const lastSessionTopic = last?.title ?? null
  const lastSessionEndedDaysAgo = last?.updated_at
    ? Math.round((Date.now() - new Date(last.updated_at).getTime()) / (1000 * 60 * 60 * 24))
    : null

  return {
    firstName:               customer?.first_name ?? null,
    vehicleShort:            `${v.year} ${v.make} ${v.model}`,
    odometerKm:              v.odometer_current != null ? Number(v.odometer_current) : null,
    nextServiceDueKm:        v.next_service_due_km != null ? Number(v.next_service_due_km) : null,
    nextServiceDueDate:      toIsoDate(v.next_service_due_date),
    regoExpiry,
    mostRecentServiceDate:   toIsoDate(recent?.service_date),
    mostRecentServiceStore:  recent?.store ?? null,
    unreadRecommendations:   Number((recCount as any)?.n ?? 0),
    memoryNotes,
    priorSessionCount,
    lastSessionTopic,
    lastSessionEndedDaysAgo,
  }
}
