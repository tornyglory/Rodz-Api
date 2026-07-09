import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, forbidden, notFound, serverError } from '../../shared/errors'
import { checkAndRecord } from '../../shared/rateLimit'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const MAX_DRAFT_LEN      = 2000
const GENERATE_THRESHOLD = 20

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

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

    const [[v]] = await db.query<any[]>(
      `SELECT year, make, model, series, colour, body_type, fuel_type, transmission,
              engine_size_cc, cylinders, odometer_current, for_sale, asking_price, city, country
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!v) return notFound('Vehicle')

    const [[svc]] = await db.query<any[]>(
      `SELECT COUNT(*) AS service_count, MAX(vsl.service_date) AS last_service
       FROM vehicle_service_log vsl
       WHERE vsl.vehicle_rego = (SELECT rego FROM vehicles WHERE id = ? LIMIT 1)`,
      [vehicleId],
    )

    const engineSize   = v.engine_size_cc ? `${(Number(v.engine_size_cc) / 1000).toFixed(1)}L` : null
    const odometer     = v.odometer_current ? `${Number(v.odometer_current).toLocaleString()} km` : 'unknown'
    const serviceCount = Number(svc?.service_count ?? 0)
    const location     = [v.city, v.country].filter(Boolean).join(', ') || 'not specified'
    const listing      = v.for_sale
      ? `Listed for sale${v.asking_price ? ` at $${Number(v.asking_price).toLocaleString()} AUD` : ''}. Location: ${location}.`
      : 'Not currently listed for sale.'

    const mode = draft.length < GENERATE_THRESHOLD ? 'generate' : 'polish'

    const prompt = mode === 'generate'
      ? `Write a short, warm description for a car listing on Rodz. Speak in the first person from the owner's perspective ("She's been..."). Keep it 3-5 sentences. Highlight the vehicle's character and history — NOT a spec sheet (the specs are shown separately on the profile). Do not invent details beyond what's provided.

Vehicle facts:
- ${v.year} ${v.make} ${v.model}${v.series ? ` ${v.series}` : ''}
- Colour: ${v.colour ?? 'unspecified'}
- Body: ${v.body_type ?? 'unspecified'} | Fuel: ${v.fuel_type ?? 'unspecified'} | Transmission: ${v.transmission ?? 'unspecified'}${engineSize ? ` | Engine: ${engineSize}` : ''}
- Odometer: ${odometer}
- Documented services at Rodz workshops: ${serviceCount}
- ${listing}

Return ONLY the description text — no preamble, no quotes, no markdown headings.`
      : `Polish this car listing description. Fix grammar, tighten wording, keep the same voice and meaning. Do NOT add facts that aren't in the original. Keep it 3-5 sentences, first person from the owner's perspective. Under 600 characters.

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
      console.error('LLM error on vehicle description enhance:', err)
      return json(503, { error: { code: 'AI_UNAVAILABLE', message: 'The enhancer is temporarily unavailable. Please try again shortly.' } })
    }
  } catch (err) {
    return serverError(err)
  }
}
