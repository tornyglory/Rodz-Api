import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

const ready    = bootstrap()
const CF_HASH  = process.env.CF_ACCOUNT_HASH ?? ''

const SCAN_PROMPT = `You are analysing an image from a vehicle owner's expense tracker.

Step 1 — Classify the image. Choose ONE of:
fuel_receipt, ev_receipt, pump_photo, workshop_invoice, parts_receipt,
car_wash_receipt, parking_receipt, toll_receipt, insurance_receipt,
registration_receipt, other_receipt, unclear

Step 2 — Extract all fields relevant to the classification.

Return valid JSON only, no markdown, no explanation:
{
  "classification": "<type>",
  "confidence": "high" | "medium" | "low",
  "category": "fuel" | "ev_charging" | "workshop" | "parts" | "car_wash" | "parking" | "tolls" | "registration" | "insurance" | "roadside" | "other",
  "merchantName": string | null,
  "merchantSuburb": string | null,
  "merchantState": string | null,
  "amountAud": number | null,
  "expenseDate": "YYYY-MM-DD" | null,
  "odometerKm": number | null,
  "fuelType": "unleaded_91" | "unleaded_95" | "unleaded_98" | "diesel" | "lpg" | "e10" | null,
  "fuelLitres": number | null,
  "pricePerLitre": number | null,
  "evKwh": number | null,
  "pricePerKwh": number | null,
  "allFuelPrices": [{ "fuelType": string, "pricePerLitre": number }] | null,
  "notes": string | null
}

For pump_photo, populate allFuelPrices with every fuel type and price visible on the board.
Use null for any field not visible or not applicable.`

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

    const result   = await model.generateContent([
      { text: SCAN_PROMPT },
      { inlineData: { mimeType, data: base64 } },
    ])
    const raw      = result.response.text().trim()
    const match    = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
    const jsonText = match ? match[1].trim() : raw

    let extracted: any = null
    let classification = 'unclear'
    let confidence     = 'low'

    try {
      const parsed   = JSON.parse(jsonText)
      classification = parsed.classification ?? 'unclear'
      confidence     = parsed.confidence ?? 'low'

      if (classification !== 'unclear') {
        extracted = {
          category:       parsed.category      ?? null,
          merchantName:   parsed.merchantName  ?? null,
          merchantSuburb: parsed.merchantSuburb ?? null,
          merchantState:  parsed.merchantState  ?? null,
          amountAud:      parsed.amountAud      != null ? Number(parsed.amountAud)      : null,
          expenseDate:    parsed.expenseDate    ?? null,
          odometerKm:     parsed.odometerKm     != null ? Number(parsed.odometerKm)     : null,
          fuelType:       parsed.fuelType        ?? null,
          fuelLitres:     parsed.fuelLitres      != null ? Number(parsed.fuelLitres)    : null,
          pricePerLitre:  parsed.pricePerLitre   != null ? Number(parsed.pricePerLitre) : null,
          evKwh:          parsed.evKwh           != null ? Number(parsed.evKwh)         : null,
          pricePerKwh:    parsed.pricePerKwh     != null ? Number(parsed.pricePerKwh)   : null,
          allFuelPrices:  parsed.allFuelPrices   ?? null,
          notes:          parsed.notes           ?? null,
        }
      }
    } catch {
      classification = 'unclear'
      confidence     = 'low'
    }

    return ok({ imageId, classification, confidence, extracted })
  } catch (err) {
    return serverError(err)
  }
}
