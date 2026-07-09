import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, notFound, serverError } from '../../shared/errors'
import { checkAndRecord } from '../../shared/rateLimit'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const MAX_DRAFT_LEN     = 2000
const GENERATE_THRESHOLD = 20

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body  = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const draft = typeof body.description === 'string' ? body.description.trim() : ''
    if (draft.length > MAX_DRAFT_LEN) {
      return validationError(`description must be ${MAX_DRAFT_LEN} characters or fewer.`)
    }

    // Rate limit: 20/hour per customer
    const rate = await checkAndRecord(db, [
      { key: `enhance:customer:${ctx.customerId}`, limit: 20, windowSeconds: 3600 },
    ])
    if (!rate.ok) {
      return json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many enhancement requests. Please try again later.' } },
        { 'Retry-After': String(rate.retryAfter) },
      )
    }

    // Load context about the customer (their owned vehicles, member-since date)
    const [[cust]] = await db.query<any[]>(
      `SELECT first_name, last_name, suburb, state, created_at
       FROM customers WHERE id = ? AND is_active = 1 LIMIT 1`,
      [ctx.customerId],
    )
    if (!cust) return notFound('Customer')

    const [vehicles] = await db.query<any[]>(
      `SELECT v.year, v.make, v.model
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.year DESC
       LIMIT 6`,
      [ctx.customerId],
    )

    const memberSince = cust.created_at
      ? (cust.created_at instanceof Date ? cust.created_at.getFullYear() : new Date(cust.created_at).getFullYear())
      : null
    const vehicleList = vehicles.length
      ? vehicles.map((v: any) => `${v.year} ${v.make} ${v.model}`).join(', ')
      : 'none listed'
    const location = [cust.suburb, cust.state].filter(Boolean).join(', ') || 'not specified'

    const mode = draft.length < GENERATE_THRESHOLD ? 'generate' : 'polish'

    const prompt = mode === 'generate'
      ? `Write a short, friendly "about me" bio for a Rodz customer who lists cars on the platform. Speak in the first person ("I..."). Keep it 2-3 short sentences, warm and casual — NOT salesy or corporate. Do not invent details beyond what's provided.

Facts about them:
- Name: ${cust.first_name}
- Location: ${location}
- Member since: ${memberSince ?? 'unknown'}
- Current vehicles: ${vehicleList}

Return ONLY the bio text — no preamble, no quotes, no markdown.`
      : `Polish this "about me" bio for a Rodz customer. Fix grammar, tighten wording, keep the same voice and meaning. Do NOT add facts that aren't in the original. Keep it 2-3 sentences, first person, warm and casual. Under 500 characters.

Original:
"""
${draft}
"""

Return ONLY the polished bio — no preamble, no quotes, no markdown.`

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
      const model = genAI.getGenerativeModel({
        model:            'gemini-2.5-flash',
        generationConfig: { maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } } as any,
      })
      const result   = await model.generateContent(prompt)
      const enhanced = result.response.text().trim().replace(/^["']|["']$/g, '')
      if (!enhanced) throw new Error('Empty LLM response')
      return ok({ enhanced, mode })
    } catch (err) {
      console.error('LLM error on customer description enhance:', err)
      return json(503, { error: { code: 'AI_UNAVAILABLE', message: 'The enhancer is temporarily unavailable. Please try again shortly.' } })
    }
  } catch (err) {
    return serverError(err)
  }
}
