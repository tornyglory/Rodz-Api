import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { safeGet, safeSetEx } from '../../shared/redis'
import { loadSession, SessionMessage } from '../../customer/vehicles/chats/messagesStore'

const ready = bootstrap()

const VALID_AGENTS = new Set(['booking', 'expense', 'fuel', 'vehicle', 'logbook', 'quote'])

// POST /admin/chat-feedback/{feedbackId}/suggest-fix
//
// Focused per-👎 fix suggestion. Loads the specific feedback row + the
// AI reply and preceding user turn from S3, sends a single exchange to
// Gemini, returns ONE proposed prompt edit ready to feed straight into
// `POST /admin/prompts/apply-edits`. Small corpus → fast (3-8s), stays
// well under the 30s API Gateway timeout that broke the batch review.
//
// Idempotent. Cached in Redis by (feedbackId, updated_at) for 24h so
// re-viewing the same row is instant; if the reviewer edits the reason
// the cache invalidates automatically.
//
// Only works on 👎 rows. 👍 → 422 NOT_A_DOWN_RATING.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  const feedbackId = Number(event.pathParameters?.feedbackId)
  if (!Number.isFinite(feedbackId) || feedbackId <= 0) return notFound('Feedback')

  try {
    const [[fb]] = await db.query<any[]>(
      `SELECT id, customer_id, vehicle_id, session_id, message_id, rating,
              reason, prompt_version, created_at, updated_at
       FROM chat_message_feedback WHERE id = ? LIMIT 1`,
      [feedbackId],
    )
    if (!fb) return notFound('Feedback')

    if (fb.rating !== 'down') {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'NOT_A_DOWN_RATING', message: 'Suggest-fix only applies to 👎 feedback rows.' },
        }),
      }
    }

    const updatedAtIso = toIso(fb.updated_at)
    const cacheKey = `admin:chat-feedback:suggest-fix:${feedbackId}:${updatedAtIso}`
    const cached = await safeGet<Record<string, unknown>>(cacheKey)
    if (cached) return ok({ ...cached, cached: true })

    // Load the AI reply + preceding user turn from S3.
    const { blob } = await loadSession(Number(fb.session_id))
    if (!blob) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'MESSAGE_UNAVAILABLE', message: 'Session blob could not be loaded from S3 (archived or missing).' },
        }),
      }
    }
    const msgs   = blob.messages ?? []
    const aiIdx  = msgs.findIndex(m => m.id === String(fb.message_id))
    const aiMsg  = aiIdx >= 0 ? msgs[aiIdx] : null
    if (!aiMsg || aiMsg.role !== 'model' || !aiMsg.content) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'MESSAGE_UNAVAILABLE', message: 'AI message not found in session.' },
        }),
      }
    }
    const userMsg = walkBackToUser(msgs, aiIdx)

    const exchange = {
      customerId:    Number(fb.customer_id),
      vehicleId:     Number(fb.vehicle_id),
      sessionId:     Number(fb.session_id),
      messageId:     String(fb.message_id),
      rating:        'down' as const,
      reason:        fb.reason ?? null,
      promptVersion: fb.prompt_version ?? null,
      userTurn:      userMsg?.content ?? null,
      aiReply:       String(aiMsg.content).slice(0, 3000),
      createdAt:     toIso(fb.created_at),
    }

    const suggestedEdit = await runGeminiSuggestFix(exchange)

    const response = {
      feedbackId,
      exchange,
      suggestedEdit,
    }

    await safeSetEx(cacheKey, 60 * 60 * 24, response)  // 24h

    return ok({ ...response, cached: false })
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

interface SuggestedEdit {
  target:      'system-prompt' | 'agent'
  agentName:   string | null
  instruction: string
  rationale:   string
}

async function runGeminiSuggestFix(exchange: {
  userTurn:      string | null
  aiReply:       string
  reason:        string | null
  promptVersion: string | null
}): Promise<SuggestedEdit> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are reviewing ONE 👎 rating on Rodz — an AI assistant that helps a customer with their vehicle. The customer thumbed down this AI reply. They may or may not have given a reason.

Your job: propose EXACTLY ONE prompt edit that, if applied, would prevent this failure next time. Keep it tight and specific.

Rules:
1. **One edit only.** Not multiple.
2. **Scope correctly:**
   - Voice, tone, or cross-cutting behaviour issue → \`target: "system-prompt"\`, \`agentName: null\`.
   - Failure clearly belongs to a specific agent's domain → \`target: "agent"\` with the correct \`agentName\` (one of: booking, expense, fuel, vehicle, logbook, quote). Match the intent of the customer's message.
3. **Positive instruction.** Phrase as "do X" or "when Y, do Z" — not "don't do X". Concrete enough to sit at the end of a system prompt and change behaviour.
4. **Rationale** should explicitly connect to the customer's actual complaint (or, if no reason given, to what looks broken about the reply).
5. **Return JSON only.** No markdown fences, no prose. Just the object.

Response shape:
{
  "target": "system-prompt" | "agent",
  "agentName": null | "booking" | "expense" | "fuel" | "vehicle" | "logbook" | "quote",
  "instruction": "…",
  "rationale": "…"
}

The exchange:
- Customer said: ${JSON.stringify(exchange.userTurn ?? '(no preceding user turn found)')}
- Rodz replied: ${JSON.stringify(exchange.aiReply)}
- Customer's reason for 👎: ${JSON.stringify(exchange.reason ?? '(no reason given)')}
${exchange.promptVersion ? `- Rodz was running prompt version: ${exchange.promptVersion}` : ''}`

  const result = await model.generateContent(prompt)
  const text   = result.response.text()
  const parsed = JSON.parse(stripFences(text))

  const target = parsed.target === 'agent' ? 'agent' : 'system-prompt'
  const agentName =
    target === 'agent' && typeof parsed.agentName === 'string' && VALID_AGENTS.has(parsed.agentName)
      ? parsed.agentName
      : null
  // If Gemini said target=agent but the agent name is invalid, downgrade
  // to system-prompt rather than saving a rule no agent will read.
  const finalTarget = target === 'agent' && !agentName ? 'system-prompt' : target

  return {
    target:      finalTarget,
    agentName:   finalTarget === 'agent' ? agentName : null,
    instruction: String(parsed.instruction ?? '').trim().slice(0, 800),
    rationale:   String(parsed.rationale ?? '').trim().slice(0, 500),
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
