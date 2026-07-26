import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, gone, validationError, serverError } from '../../shared/errors'
import { checkAndRecord } from '../../shared/rateLimit'
import { isTone, toneStyle, type Tone } from '../../shared/descriptionEnhance'

const ready = bootstrap()

const MAX_DRAFT_LEN      = 2000
const GENERATE_THRESHOLD = 20

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[v]] = await db.query<any[]>(
      `SELECT v.id, v.is_active, v.year, v.make, v.model, v.series, v.colour,
              v.body_type, v.fuel_type, v.transmission, v.engine_size_cc, v.cylinders,
              v.odometer_current, v.for_sale, v.asking_price, v.city, v.country,
              v.rego, c.description AS owner_description
         FROM vehicles v
         JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
         JOIN customers c       ON c.id = vo.customer_id
        WHERE v.id = ? AND vo.customer_id = ?
        LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!v)          return notFound('Vehicle')
    if (!v.is_active) return gone('Vehicle')

    const body  = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const draft = typeof body.description === 'string' ? body.description.trim() : ''
    if (draft.length > MAX_DRAFT_LEN) {
      return validationError(`description must be ${MAX_DRAFT_LEN} characters or fewer.`)
    }

    // Tone is optional — missing means 'neutral'. If present, MUST be an
    // enum value. Fail loud rather than silently downgrading.
    let tone: Tone = 'neutral'
    if ('tone' in body && body.tone !== undefined && body.tone !== null) {
      if (!isTone(body.tone)) {
        return json(422, { error: {
          code:    'INVALID_TONE',
          message: 'tone must be one of: neutral, nostalgic, sale, enthusiast, casual, concise.',
        }})
      }
      tone = body.tone
    }

    // Rate limit — mirror of customer endpoint: 20/hour per vehicle (staff can
    // enhance multiple customers' cars so keying by staff would be too loose).
    const rate = await checkAndRecord(db, [
      { key: `enhance:staff:${ctx.staffId}`,   limit: 60, windowSeconds: 3600 },
      { key: `enhance:vehicle:${v.id}`,        limit: 20, windowSeconds: 3600 },
    ])
    if (!rate.ok) {
      return json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many enhancement requests. Please try again later.' } },
        { 'Retry-After': String(rate.retryAfter) },
      )
    }

    const [[svc]] = await db.query<any[]>(
      `SELECT COUNT(*) AS service_count
       FROM vehicle_service_log vsl
       WHERE vsl.vehicle_rego = ?`,
      [v.rego],
    )

    const engineSize   = v.engine_size_cc ? `${(Number(v.engine_size_cc) / 1000).toFixed(1)}L` : null
    const odometer     = v.odometer_current ? `${Number(v.odometer_current).toLocaleString()} km` : 'unknown'
    const serviceCount = Number(svc?.service_count ?? 0)
    const location     = [v.city, v.country].filter(Boolean).join(', ') || 'not specified'
    const listing      = v.for_sale
      ? `Listed for sale${v.asking_price ? ` at $${Number(v.asking_price).toLocaleString()} AUD` : ''}. Location: ${location}.`
      : 'Not currently listed for sale.'
    const ownerBio     = v.owner_description ? String(v.owner_description).trim() : ''

    const mode = draft.length < GENERATE_THRESHOLD ? 'generate' : 'polish'

    const voice = toneStyle(tone)

    const prompt = mode === 'generate'
      ? `Write a description for this car listing on Rodz.

Voice: ${voice}

Highlight the vehicle's character and history — NOT a spec sheet (the specs are shown separately on the profile). Do not invent details beyond what's provided.

Vehicle facts:
- ${v.year} ${v.make} ${v.model}${v.series ? ` ${v.series}` : ''}
- Colour: ${v.colour ?? 'unspecified'}
- Body: ${v.body_type ?? 'unspecified'} | Fuel: ${v.fuel_type ?? 'unspecified'} | Transmission: ${v.transmission ?? 'unspecified'}${engineSize ? ` | Engine: ${engineSize}` : ''}
- Odometer: ${odometer}
- Documented services at Rodz workshops: ${serviceCount}
- ${listing}
${ownerBio ? `- Owner bio: ${ownerBio}` : ''}

Return ONLY the description text — no preamble, no quotes, no markdown headings.`
      : `Polish this car listing description.

Voice: ${voice}

Fix grammar, tighten wording. Do NOT add facts that aren't in the original. Under 600 characters.

Original:
"""
${draft}
"""

Return ONLY the polished description — no preamble, no quotes, no markdown.`

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
      const model = genAI.getGenerativeModel({
        model:            'gemini-2.5-flash',
        generationConfig: { maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } } as any,
      })
      const result   = await model.generateContent(prompt)
      const enhanced = result.response.text().trim().replace(/^["']|["']$/g, '')
      if (!enhanced) throw new Error('Empty LLM response')
      return ok({ enhanced, mode })
    } catch (err) {
      console.error('LLM error on staff vehicle description enhance:', err)
      return json(503, { error: { code: 'AI_UNAVAILABLE', message: 'The enhancer is temporarily unavailable. Please try again shortly.' } })
    }
  } catch (err) {
    return serverError(err)
  }
}
