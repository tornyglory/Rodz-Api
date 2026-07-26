import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { checkAndRecord } from '../../shared/rateLimit'
import { isTone, toneStyle, type Tone } from '../../shared/descriptionEnhance'
import { loadProfileForVehicle, shapeProfile } from '../../shared/vehicleProfile'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

// POST /c/vehicles/{id}/profile/regenerate
// Owner-only. Rewrites the voice-bearing fields of the AI profile in the
// caller's chosen tone and persists a per-vehicle override. Structured
// fields (engineSpecs, tyreSpecs, commonRepairs) are unchanged.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    // 1. Ownership guard
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.make, v.model, v.year
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, ctx.customerId],
    )
    if (!vehicle) return forbidden('NOT_OWNER', 'You do not own this vehicle.')

    // 2. Parse + validate tone (default neutral)
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
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

    // 3. Rate limit: 5 regens/hour per vehicle (tighter than description enhance
    // because a full regen is more expensive)
    const rate = await checkAndRecord(db, [
      { key: `profile-regen:vehicle:${vehicleId}`, limit: 5, windowSeconds: 3600 },
    ])
    if (!rate.ok) {
      return json(429, {
        error: {
          code:              'RATE_LIMITED',
          message:           'Too many profile regenerations for this vehicle. Try again later.',
          retryAfterSeconds: rate.retryAfter,
        },
      }, { 'Retry-After': String(rate.retryAfter) })
    }

    // 4. Load the base profile. If it's not there yet, the async engine
    // hasn't finished the initial generation — tell the caller to retry.
    const { base } = await loadProfileForVehicle(db, vehicle)
    if (!base) {
      return json(409, { error: {
        code:    'PROFILE_PENDING',
        message: 'The profile is still being generated for this vehicle. Try again shortly.',
      }})
    }

    // 5. Prompt the LLM. Grounded strictly in the base profile — the LLM
    // rewrites voice, not facts. Titles + severities on knownIssues stay
    // byte-identical; only the description text gets the new voice.
    const voice = toneStyle(tone)

    const baseKnownIssues = (Array.isArray(base.known_issues) ? base.known_issues : [])
      .map((k: any) => ({
        title:       String(k?.title ?? '').slice(0, 200),
        description: String(k?.description ?? ''),
        severity:    (['low','medium','high'].includes(String(k?.severity)) ? k.severity : 'medium') as string,
      }))
    const baseServiceNotes = Array.isArray(base.service_notes) ? base.service_notes.map(String) : []

    const prompt = `You are rewriting the voice-bearing fields of a workshop reference profile for a ${vehicle.year} ${vehicle.make} ${vehicle.model} in a new voice. You MUST NOT invent facts. Every rewritten field must convey the SAME information as the original — only the sentence structure, word choice, and register may change.

Voice: ${voice}

Return a JSON object only, no markdown, with this exact structure:
{
  "overview": "rewritten in the target voice; length appropriate to the voice (concise/casual = short, others = 2-3 sentences)",
  "serviceNotes": [
    "each note from the input, rewritten in the target voice (keep the same facts, just change the wording)"
  ],
  "knownIssues": [
    {
      "title":       "PRESERVE the input title byte-identically",
      "description": "rewritten in the target voice; same information, new wording",
      "severity":    "PRESERVE the input severity byte-identically"
    }
  ]
}

Original overview: ${base.overview}

Original serviceNotes: ${JSON.stringify(baseServiceNotes)}

Original knownIssues: ${JSON.stringify(baseKnownIssues)}`

    let rewritten: { overview: string; serviceNotes: string[]; knownIssues: any[] }
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
      const model = genAI.getGenerativeModel({
        model:            'gemini-2.5-flash',
        generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } as any,
      })
      const result = await model.generateContent(prompt)
      rewritten = JSON.parse(stripFences(result.response.text()))
    } catch (err) {
      console.error('LLM error on vehicle profile regenerate:', err)
      return json(503, { error: {
        code:    'AI_UNAVAILABLE',
        message: 'The regenerator is temporarily unavailable. Please try again shortly.',
      }})
    }

    // 6. Sanity-check the LLM output. Titles + severities MUST match the
    // base — enforce this server-side so a rogue rewrite can't scrub the
    // structure or invent new issues.
    const safeKnownIssues = baseKnownIssues.map((base: any, i: number) => {
      const rewrite = Array.isArray(rewritten.knownIssues) ? rewritten.knownIssues[i] : null
      const description = typeof rewrite?.description === 'string' && rewrite.description.trim()
        ? String(rewrite.description).trim()
        : base.description
      return { title: base.title, description, severity: base.severity }
    })

    const safeServiceNotes = (Array.isArray(rewritten.serviceNotes)
      ? rewritten.serviceNotes.map((s: any) => String(s ?? '').trim()).filter(Boolean)
      : baseServiceNotes.slice()
    )
    // Length sanity: if the model dropped notes, don't lose information —
    // fall back to the base list. Extras are trimmed to the base length.
    const finalServiceNotes = safeServiceNotes.length >= baseServiceNotes.length
      ? safeServiceNotes.slice(0, baseServiceNotes.length)
      : baseServiceNotes.slice()

    const overview = typeof rewritten.overview === 'string' && rewritten.overview.trim()
      ? String(rewritten.overview).trim().replace(/^["']|["']$/g, '')
      : String(base.overview)

    // 7. Upsert the override
    await db.query(
      `INSERT INTO vehicle_profile_overrides
         (vehicle_id, tone, overview, service_notes, known_issues)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tone           = VALUES(tone),
         overview       = VALUES(overview),
         service_notes  = VALUES(service_notes),
         known_issues   = VALUES(known_issues),
         regenerated_at = NOW()`,
      [
        vehicleId,
        tone,
        overview,
        JSON.stringify(finalServiceNotes),
        JSON.stringify(safeKnownIssues),
      ],
    )

    // 8. Cache purge for the public logbook page — no CDN purge hook wired
    // yet on the backend side. Once the edge pre-render is in place this
    // is where its purge trigger goes; frontend/edge team has the details.
    // See docs/vehicle-profile-edge-prerender.md (to be added).

    // 9. Return the merged profile
    const { base: freshBase, override } = await loadProfileForVehicle(db, vehicle)
    if (!freshBase) return notFound('Profile')
    return ok(shapeProfile(vehicle, freshBase, override))
  } catch (err) {
    return serverError(err)
  }
}
