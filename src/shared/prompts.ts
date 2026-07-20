// Active prompt loader — reads the one row where `is_active = 1` in
// `prompt_versions`, caches it in Redis (30s TTL), and exposes helpers
// for composing the full system-instruction the customer chat handler
// sends to Gemini.
//
// The uniqueness of the active row is enforced by the DB
// (see docs/migrations/prompt_versions.sql). We trust it here.

import { getPool } from './db'
import { safeGet, safeSetEx, safeDel } from './redis'

const CACHE_KEY = 'prompts:active:v1'
const TTL_SEC   = 30

export interface LearnedGuidance {
  instruction:  string
  rationale:    string
  target:       'system-prompt' | 'agent'
  agentName:    string | null
  addedAt:      string
  addedBy:      number
  fromReview:   { windowDays: number; reviewedCount: number } | null
}

export interface ActivePrompt {
  id:               number
  versionLabel:     string
  basePrompt:       string
  learnedGuidance:  LearnedGuidance[]
}

// Fetch the active version. Cache-through Redis; falls open to DB on
// Redis miss/failure (safeGet/safeSetEx are already fail-open).
//
// Returns `null` if no row is active — chat handler is expected to fall
// back to its in-code persona in that case (defensive, shouldn't happen
// once seeded).
export async function loadActivePrompt(): Promise<ActivePrompt | null> {
  const cached = await safeGet<ActivePrompt>(CACHE_KEY)
  if (cached) return cached

  const db = getPool()
  const [rows] = await db.query<any[]>(
    `SELECT id, version_label, base_prompt, learned_guidance
     FROM prompt_versions
     WHERE is_active = 1
     LIMIT 1`,
  )
  if (rows.length === 0) return null

  const row = rows[0]
  const record: ActivePrompt = {
    id:              Number(row.id),
    versionLabel:    String(row.version_label),
    basePrompt:      String(row.base_prompt),
    learnedGuidance: parseGuidance(row.learned_guidance),
  }

  await safeSetEx(CACHE_KEY, TTL_SEC, record)
  return record
}

// Called by every save/apply/activate handler after writing.
export async function invalidateActivePromptCache(): Promise<void> {
  await safeDel(CACHE_KEY)
}

// Renders the learned_guidance array as a plain-text block ready to
// paste after the base persona. Filters by target/agentName so the
// customer chat handler only sees `system-prompt` rules (v1); agents
// can filter their own rules later.
export function renderLearnedGuidance(
  guidance: LearnedGuidance[],
  opts: { target: 'system-prompt' | 'agent'; agentName?: string | null } = { target: 'system-prompt' },
): string {
  const filtered = guidance.filter(g => {
    if (opts.target !== g.target) return false
    if (g.target === 'agent') return g.agentName === opts.agentName
    return true
  })
  if (filtered.length === 0) return ''
  const lines = filtered.map((g, i) => `${i + 1}. ${g.instruction.trim()}`)
  return [
    '',
    '---',
    'Learned guidance (accumulated from customer feedback — apply these when relevant):',
    ...lines,
    '',
  ].join('\n')
}

function parseGuidance(raw: unknown): LearnedGuidance[] {
  if (Array.isArray(raw)) return raw as LearnedGuidance[]
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}
