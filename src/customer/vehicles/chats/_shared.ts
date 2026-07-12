import type mysql from 'mysql2/promise'

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
  outstandingIssues:      string[]        // from assistant memory notes
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
  const outstanding = memory
    .filter(m => /noise|issue|clicking|leak|smell|vibration|problem|wait|see if|clear up|follow up/i.test(m.note))
    .slice(0, 3)
    .map(m => m.note)

  return {
    firstName:              customer?.first_name ?? null,
    vehicleShort:           `${v.year} ${v.make} ${v.model}`,
    odometerKm:             v.odometer_current != null ? Number(v.odometer_current) : null,
    nextServiceDueKm:       v.next_service_due_km != null ? Number(v.next_service_due_km) : null,
    nextServiceDueDate:     toIsoDate(v.next_service_due_date),
    regoExpiry,
    mostRecentServiceDate:  toIsoDate(recent?.service_date),
    mostRecentServiceStore: recent?.store ?? null,
    unreadRecommendations:  Number((recCount as any)?.n ?? 0),
    outstandingIssues:      outstanding,
  }
}
