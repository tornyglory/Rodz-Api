import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, POLICY_TYPES, isPolicyType } from './_helpers'

const ready   = bootstrap()
const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

// Classifies a photo the customer took of a policy document (rego label /
// renewal notice, WoF certificate, insurance card, roadside membership
// card) and extracts the fields needed to create a `vehicle_policies`
// row. Does NOT persist — returns a draft the frontend uses to prefill
// the policy edit sheet. Customer confirms + saves via the normal
// `POST /c/vehicles/{id}/policies` flow.
//
// If an active policy of the classified type already exists, the response
// carries `existingPolicyId` so the frontend can offer "replace" or "cancel"
// instead of triggering a 409 on save.

const SCAN_PROMPT = `You are analysing an image from a vehicle owner's coverage folder — one of these four documents:

- **registration** — vehicle registration label, rego renewal notice, or government registration invoice (issuers: NZTA, VicRoads, Service NSW, TMR, etc.)
- **wof** — Warrant of Fitness (NZ) or Roadworthy Certificate (AU) inspection certificate (issuers: VTNZ, VINZ, RWC-authorised inspectors)
- **insurance** — vehicle insurance policy card, certificate of currency, or renewal notice (issuers: AAMI, State Insurance, AA Insurance, Suncorp, RACV, NRMA, Allianz, etc.)
- **roadside** — roadside assist membership card or renewal notice (issuers: AA Roadservice, RACV, NRMA, RACQ, etc.)

Step 1 — Classify the image. Choose ONE of:
registration, wof, insurance, roadside, unclear

Choose \`unclear\` if the image is blurry, cut off, or clearly none of the above (e.g. a fuel receipt, a random photo).

Step 2 — Extract every field visible on the document.

Return valid JSON only, no markdown, no explanation:
{
  "classification":  "registration" | "wof" | "insurance" | "roadside" | "unclear",
  "confidence":      "high" | "medium" | "low",
  "provider":        string | null,        // issuer / insurer / inspection station name
  "policyNumber":    string | null,        // policy #, member #, certificate #, rego label #
  "costAud":         number | null,        // premium / fee / renewal cost in AUD
  "effectiveFrom":   "YYYY-MM-DD" | null,  // policy start / inspection date
  "expiresOn":       "YYYY-MM-DD" | null,  // renewal / next-inspection-due date
  "phone":           string | null,        // claims line for insurance; 24/7 breakdown for roadside; null otherwise
  "notes":           string | null         // any short useful text — excess amount, coverage line items, membership tier
}

Rules:
- Convert dates to YYYY-MM-DD regardless of source format ("15 Feb 2027" → "2027-02-15", "01/02/27" → "2027-02-01" assuming AU/NZ D/M/Y).
- Numbers: strip $ / commas. Don't invent decimals — "$1420" → 1420, not 1420.50.
- \`phone\` — only populate for insurance (claims) or roadside (24/7). Leave null for registration and wof.
- If a field isn't visible or you're guessing, use null. Never fabricate a policy number.
- If the classification is \`unclear\`, still fill any fields you can see — the customer might correct the classification and reuse the data.`

interface Extracted {
  provider:      string | null
  policyNumber:  string | null
  costAud:       number | null
  effectiveFrom: string | null
  expiresOn:     string | null
  phone:         string | null
  notes:         string | null
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  if (!vehicleId) return notFound('Vehicle')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const body    = JSON.parse(event.body ?? '{}')
    const imageId = body.imageId ? String(body.imageId) : null
    if (!imageId) return validationError('imageId is required')

    const imageUrl = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
    const imageRes = await fetch(imageUrl)
    if (!imageRes.ok) return validationError('Image not found — upload may not have completed')

    const mimeType = imageRes.headers.get('content-type') ?? 'image/jpeg'
    const base64   = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model:            'gemini-2.5-flash',
      generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    let classification = 'unclear'
    let confidence     = 'low'
    let extracted: Extracted | null = null

    try {
      const result = await model.generateContent([
        { text: SCAN_PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ])
      const raw      = result.response.text().trim()
      const match    = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
      const jsonText = match ? match[1].trim() : raw
      const parsed   = JSON.parse(jsonText)

      classification = String(parsed.classification ?? 'unclear')
      confidence     = String(parsed.confidence ?? 'low')

      extracted = {
        provider:      parsed.provider      ?? null,
        policyNumber:  parsed.policyNumber  ?? null,
        costAud:       parsed.costAud       != null ? Number(parsed.costAud) : null,
        effectiveFrom: parsed.effectiveFrom ?? null,
        expiresOn:     parsed.expiresOn     ?? null,
        phone:         parsed.phone         ?? null,
        notes:         parsed.notes         ?? null,
      }
    } catch (err) {
      console.error('policies/scan LLM error:', err)
      classification = 'unclear'
      confidence     = 'low'
      extracted      = null
    }

    // If the classification is one of the four types and an active policy
    // of that type already exists, return its id so the frontend can offer
    // "replace" instead of running headlong into a 409.
    let existingPolicyId: number | null = null
    if (isPolicyType(classification)) {
      const [[row]] = await db.query<any[]>(
        `SELECT id FROM vehicle_policies
          WHERE vehicle_id = ? AND type = ? AND deleted_at IS NULL
          LIMIT 1`,
        [vehicleId, classification],
      )
      if (row) existingPolicyId = Number(row.id)
    }

    return ok({
      imageId,
      classification,
      confidence,
      extracted,
      existingPolicyId,
      allowedTypes: POLICY_TYPES,
    })
  } catch (err) {
    return serverError(err)
  }
}
