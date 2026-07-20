// Shared helpers for the /admin/prompts endpoints.

import mysql from 'mysql2/promise'

// Anything with a `.query()` method — pool OR held connection. Used so
// transactional callers can pass their held conn (pool has
// connectionLimit=1, so grabbing a second connection inside a tx
// deadlocks).
export type Executor = Pick<mysql.Pool, 'query'> | Pick<mysql.PoolConnection, 'query'>

export interface PromptVersionRow {
  id:                number
  version_label:     string
  base_prompt:       string
  learned_guidance:  unknown
  notes:             string | null
  source:            'manual' | 'review-apply' | 'revert'
  source_review:     unknown
  parent_version_id: number | null
  saved_by:          number
  saved_at:          any
  is_active:         number
  saved_by_first?:   string | null
  saved_by_last?:    string | null
}

// Shape a raw prompt_versions row (with staff join fields) into the API
// response object.
export function shapeVersion(row: PromptVersionRow, feedback?: FeedbackAggregate | null): Record<string, unknown> {
  return {
    id:               Number(row.id),
    versionLabel:     String(row.version_label),
    basePrompt:       String(row.base_prompt),
    learnedGuidance:  toArray(row.learned_guidance),
    notes:            row.notes ?? null,
    source:           row.source,
    sourceReview:     toObj(row.source_review),
    parentVersionId:  row.parent_version_id != null ? Number(row.parent_version_id) : null,
    savedBy:          {
      id:   Number(row.saved_by),
      name: `${row.saved_by_first ?? ''} ${row.saved_by_last ?? ''}`.trim() || null,
    },
    savedAt:          toIso(row.saved_at),
    isActive:         Number(row.is_active) === 1,
    feedback:         feedback ?? null,
  }
}

// Lightweight row for search/list views. Drops the two big blobs
// (basePrompt + learnedGuidance) and replaces them with derived
// counts, so a 50-row search response is ~10KB instead of ~500KB.
// The full row loads on demand via `GET /admin/prompts/{id}`.
export function shapeVersionLite(row: PromptVersionRow, feedback?: FeedbackAggregate | null): Record<string, unknown> {
  const guidance = toArray(row.learned_guidance) as Array<{ agentName?: string | null; target?: string }>
  const agentNames = Array.from(new Set(
    guidance
      .filter(g => g.target === 'agent' && typeof g.agentName === 'string' && g.agentName)
      .map(g => g.agentName as string),
  )).sort()
  return {
    id:                    Number(row.id),
    versionLabel:          String(row.version_label),
    notes:                 row.notes ?? null,
    source:                row.source,
    sourceReview:          toObj(row.source_review),
    parentVersionId:       row.parent_version_id != null ? Number(row.parent_version_id) : null,
    savedBy:               {
      id:   Number(row.saved_by),
      name: `${row.saved_by_first ?? ''} ${row.saved_by_last ?? ''}`.trim() || null,
    },
    savedAt:               toIso(row.saved_at),
    isActive:              Number(row.is_active) === 1,
    feedback:              feedback ?? null,
    learnedGuidanceCount:  guidance.length,
    agentNames,                              // unique agent names touched by this version's guidance
    basePromptLength:      String(row.base_prompt ?? '').length,
  }
}

export interface FeedbackAggregate { total: number; up: number; down: number; upRate: number | null }

// Batch-fetch feedback aggregates for a set of version labels. Returns a
// Map keyed by version_label. Cheap single-query join on the feedback
// table — same shape as the one used in `/admin/chat-feedback`.
//
// Accepts either a pool or a held connection (Executor) so transactional
// callers can pass their held conn — pool has connectionLimit=1, so
// grabbing a second connection inside a tx deadlocks.
export async function fetchFeedbackAggregates(
  exec: Executor,
  versionLabels: string[],
): Promise<Map<string, FeedbackAggregate>> {
  const out = new Map<string, FeedbackAggregate>()
  if (versionLabels.length === 0) return out

  const [rows] = await (exec as mysql.Pool).query<any[]>(
    `SELECT prompt_version,
            COUNT(*)                                        AS total,
            SUM(CASE WHEN rating = 'up'   THEN 1 ELSE 0 END) AS up_count,
            SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down_count
     FROM chat_message_feedback
     WHERE prompt_version IN (?)
     GROUP BY prompt_version`,
    [versionLabels],
  )
  for (const r of rows) {
    const total = Number(r.total)
    const up    = Number(r.up_count)
    const down  = Number(r.down_count)
    out.set(String(r.prompt_version), {
      total, up, down,
      upRate: total > 0 ? Number((up / total).toFixed(3)) : null,
    })
  }
  return out
}

// Version label format: v{N}-{YYYY-MM-DD}-{HH:mm}[-slug]
// N monotonically increases across all rows (never re-uses a number).
export async function nextVersionLabel(exec: Executor, slug: string | null): Promise<string> {
  const [rows] = await (exec as mysql.Pool).query<any[]>(
    `SELECT version_label FROM prompt_versions ORDER BY id DESC LIMIT 200`,
  )
  let maxN = 0
  for (const r of rows) {
    const m = /^v(\d+)-/.exec(String(r.version_label))
    if (m) {
      const n = Number(m[1])
      if (n > maxN) maxN = n
    }
  }
  const now = new Date()
  const pad = (x: number) => x.toString().padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`
  const suffix = slug ? `-${slug}` : ''
  return `v${maxN + 1}-${stamp}${suffix}`
}

export function validateSlug(slug: unknown): string | null {
  if (slug === undefined || slug === null || slug === '') return null
  if (typeof slug !== 'string') throw 'slug must be a string.'
  const trimmed = slug.trim()
  if (trimmed.length < 3 || trimmed.length > 20) throw 'slug must be 3–20 characters.'
  if (!/^[a-z0-9-]+$/.test(trimmed)) throw 'slug must be lowercase letters, digits, or dashes only.'
  return trimmed
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

function toObj(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return typeof p === 'object' ? p : null } catch { return null }
  }
  return null
}

function toIso(v: any): string {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? String(v) : d.toISOString()
}

export const VERSION_SELECT = `
  v.id, v.version_label, v.base_prompt, v.learned_guidance,
  v.notes, v.source, v.source_review, v.parent_version_id,
  v.saved_by, v.saved_at, v.is_active,
  s.first_name AS saved_by_first, s.last_name AS saved_by_last
`
