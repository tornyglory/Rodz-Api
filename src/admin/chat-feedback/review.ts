import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { safeGet, safeSetEx } from '../../shared/redis'
import { loadSession, SessionMessage } from '../../customer/vehicles/chats/messagesStore'

const ready = bootstrap()

// POST /admin/chat-feedback/review?days=7
//
// Gemini reads every 👎 in the window, pulls the actual AI reply (and the
// user turn that preceded it) from S3, and returns structured findings:
//   - `themes[]`           — clusters of what customers complained about
//   - `falsePositives[]`   — 👎s where the AI reply was actually fine
//   - `proposedEdits[]`    — concrete prompt-instruction changes to try next
//
// Cached in Redis (4h) keyed by window + latest feedback timestamp so
// re-clicking within the window doesn't re-burn tokens. Cache invalidates
// automatically when a new 👎 lands.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  const qs   = event.queryStringParameters ?? {}
  const days = clamp(Number(qs.days) || 7, 1, 90)

  try {
    // Pull the raw 👎 rows. Cap at 60 — a single Gemini call comfortably
    // reads that many exchanges; larger windows just get sampled.
    const [rows] = await db.query<any[]>(
      `SELECT customer_id, vehicle_id, session_id, message_id,
              reason, prompt_version, created_at
       FROM chat_message_feedback
       WHERE rating = 'down' AND created_at >= (NOW() - INTERVAL ? DAY)
       ORDER BY created_at DESC
       LIMIT 60`,
      [days],
    )

    if (rows.length === 0) {
      return ok({
        windowDays:     days,
        reviewedCount:  0,
        themes:         [],
        falsePositives: [],
        proposedEdits:  [],
        summary:        'No 👎 feedback in this window — nothing to review.',
        cached:         false,
      })
    }

    // Cache key mixes window with the newest feedback timestamp. Any new
    // 👎 arriving pushes the key forward and invalidates the cache.
    const newestIso = toIso(rows[0].created_at)
    const cacheKey  = `admin:chat-feedback:review:${days}d:${newestIso}`

    const cached = await safeGet<Record<string, unknown>>(cacheKey)
    if (cached) {
      const withFlags = await attachAppliedFlags(db, cached)
      return ok({ ...withFlags, cached: true })
    }

    // Group by session so we do one S3 fetch per session, not per message.
    const bySession = new Map<number, any[]>()
    for (const r of rows) {
      const arr = bySession.get(Number(r.session_id)) ?? []
      arr.push(r)
      bySession.set(Number(r.session_id), arr)
    }

    // Build the exchange corpus: for each 👎, grab the AI reply + the
    // immediately-preceding user turn (context matters for judging fairness).
    const exchanges: Array<{
      customerId:    number
      sessionId:     number
      messageId:     string
      promptVersion: string | null
      userTurn:      string | null
      aiReply:       string
      reason:        string | null
      createdAt:     string
    }> = []

    for (const [sessionId, group] of bySession) {
      const { blob } = await loadSession(sessionId)
      if (!blob) continue
      const msgs = blob.messages ?? []

      for (const row of group) {
        const idx     = msgs.findIndex(m => m.id === String(row.message_id))
        const aiMsg   = idx >= 0 ? msgs[idx] : null
        if (!aiMsg || aiMsg.role !== 'model' || !aiMsg.content) continue

        // Nearest preceding user turn — walk backwards.
        const userMsg = walkBackToUser(msgs, idx)

        exchanges.push({
          customerId:    Number(row.customer_id),
          sessionId,
          messageId:     String(row.message_id),
          promptVersion: row.prompt_version ?? null,
          userTurn:      userMsg?.content ?? null,
          aiReply:       String(aiMsg.content).slice(0, 2000),
          reason:        row.reason ?? null,
          createdAt:     toIso(row.created_at),
        })
      }
    }

    if (exchanges.length === 0) {
      return ok({
        windowDays:     days,
        reviewedCount:  0,
        themes:         [],
        falsePositives: [],
        proposedEdits:  [],
        summary:        'Feedback rows exist but the referenced messages could not be loaded from S3.',
        cached:         false,
      })
    }

    const review = await runGeminiReview(exchanges)

    const response = {
      windowDays:     days,
      reviewedCount:  exchanges.length,
      themes:         review.themes,
      falsePositives: review.falsePositives,
      proposedEdits:  review.proposedEdits,
      summary:        review.summary,
    }

    // Cache the raw review body WITHOUT applied flags — flags are recomputed
    // fresh on every response so that removing a rule via the editor flips
    // corresponding proposed edits back to applied: false immediately.
    await safeSetEx(cacheKey, 60 * 60 * 4, response)  // 4h TTL

    const withFlags = await attachAppliedFlags(db, response)
    return ok({ ...withFlags, cached: false })
  } catch (err) {
    return serverError(err)
  }
}

function walkBackToUser(msgs: SessionMessage[], fromIdx: number): SessionMessage | null {
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content) return msgs[i]
  }
  return null
}

interface GeminiReview {
  themes:         Array<{ label: string; count: number; examples: string[] }>
  falsePositives: Array<{ messageId: string; note: string }>
  proposedEdits:  Array<{ target: 'system-prompt' | 'agent'; instruction: string; rationale: string }>
  summary:        string
}

async function runGeminiReview(
  exchanges: Array<{
    messageId:     string
    promptVersion: string | null
    userTurn:      string | null
    aiReply:       string
    reason:        string | null
  }>,
): Promise<GeminiReview> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  // Compact serialization keeps the prompt small even at 60 exchanges.
  const corpus = exchanges.map((e, i) => ({
    i,
    messageId:     e.messageId,
    promptVersion: e.promptVersion,
    reason:        e.reason,
    user:          e.userTurn ? String(e.userTurn).slice(0, 600) : null,
    ai:            e.aiReply.slice(0, 1200),
  }))

  const prompt = `You are reviewing 👎 (thumbs-down) feedback from Rodz — an AI assistant that speaks in first person as the customer's vehicle ("I am your car"). Rodz helps owners understand maintenance, expenses, bookings, and service history.

Below is a JSON array of exchanges the customer thumbed down. For each: what they said, what Rodz replied, and (sometimes) the reason they gave.

Your job:
1. Cluster the 👎s into 2-5 THEMES describing what went wrong (e.g. "reply too generic", "didn't use vehicle-specific data", "sounded robotic / not in-character").
2. Flag any FALSE POSITIVES — 👎s where the AI reply was actually correct and helpful, and the customer probably just didn't like the answer. Be conservative — only flag obvious ones.
3. Propose 3-8 concrete PROMPT EDITS the operator could try in the next prompt version — specific instructions that would prevent the observed failures. Each edit should target either the system prompt or a specific agent (booking, expense, fuel, vehicle, logbook).
4. Write a one-paragraph SUMMARY (2-3 sentences) capturing the headline finding.

Return JSON only. No markdown fences. Shape:
{
  "themes": [
    { "label": "reply too generic", "count": 4, "examples": ["<messageId>", "<messageId>"] }
  ],
  "falsePositives": [
    { "messageId": "<messageId>", "note": "Customer asked for X; Rodz correctly refused because Y." }
  ],
  "proposedEdits": [
    { "target": "system-prompt", "instruction": "When the customer asks about expenses, always confirm which category before summarising.", "rationale": "3 out of 7 👎s complained the summary lumped fuel + servicing together." }
  ],
  "summary": "..."
}

Rules:
- If the corpus is small (< 4 items), still produce themes but keep counts honest.
- "examples" must be messageIds copied from the input — do not invent them.
- Do not restate the raw exchanges. Analyse them.
- Focus on patterns, not individual replies (unless flagging a false positive).

Exchanges:
${JSON.stringify(corpus)}`

  const result = await model.generateContent(prompt)
  const text   = result.response.text()
  const parsed = JSON.parse(stripFences(text))

  const validEditTargets = new Set(['system-prompt', 'agent'])

  return {
    themes: Array.isArray(parsed.themes)
      ? parsed.themes.slice(0, 8).map((t: any) => ({
          label:    String(t.label ?? '').slice(0, 120),
          count:    Number.isFinite(t.count) ? Number(t.count) : 0,
          examples: Array.isArray(t.examples) ? t.examples.map((x: any) => String(x)).slice(0, 5) : [],
        }))
      : [],
    falsePositives: Array.isArray(parsed.falsePositives)
      ? parsed.falsePositives.slice(0, 20).map((f: any) => ({
          messageId: String(f.messageId ?? ''),
          note:      String(f.note ?? '').slice(0, 500),
        }))
      : [],
    proposedEdits: Array.isArray(parsed.proposedEdits)
      ? parsed.proposedEdits.slice(0, 12).map((p: any) => ({
          target:      validEditTargets.has(p.target) ? p.target : 'system-prompt',
          instruction: String(p.instruction ?? '').slice(0, 400),
          rationale:   String(p.rationale ?? '').slice(0, 400),
        }))
      : [],
    summary: String(parsed.summary ?? '').slice(0, 800),
  }
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

function toIso(v: any): string {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// Attach `applied: boolean` to each proposedEdit by cross-referencing the
// currently-active version's `learned_guidance` array. Identity of a rule
// is target + agentName + normalised instruction. Fails soft: if the DB
// lookup errors, every edit defaults to applied=false so the reviewer
// can still safely re-approve.
async function attachAppliedFlags(
  db: any,
  response: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawEdits = Array.isArray(response.proposedEdits) ? response.proposedEdits : []
  if (rawEdits.length === 0) return response

  let appliedKeys = new Set<string>()
  try {
    const [rows] = await db.query(
      `SELECT learned_guidance FROM prompt_versions WHERE is_active = 1 LIMIT 1`,
    )
    if (rows[0]) {
      const guidance = normaliseGuidanceArray(rows[0].learned_guidance)
      appliedKeys = new Set(guidance.map(editKey))
    }
  } catch (err) {
    console.error('attachAppliedFlags: failed to load active guidance', err)
    // fall through — all edits will be applied: false
  }

  const editsWithFlags = rawEdits.map((e: any) => ({
    ...e,
    applied: appliedKeys.has(editKey(e)),
  }))

  return { ...response, proposedEdits: editsWithFlags }
}

// Identity key for a rule. Trims whitespace and collapses internal
// whitespace runs to a single space. Case-sensitive — the AI produces
// stable phrasing so this is fine.
function editKey(x: { target?: string; agentName?: string | null; instruction?: string }): string {
  const t = String(x.target ?? 'system-prompt')
  const a = String(x.agentName ?? '')
  const i = String(x.instruction ?? '').trim().replace(/\s+/g, ' ')
  return `${t}::${a}::${i}`
}

function normaliseGuidanceArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}
