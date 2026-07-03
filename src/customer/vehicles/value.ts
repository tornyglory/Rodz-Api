import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

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

    const [[v]] = await db.query<any[]>(
      `SELECT make, model, year, series, fuel_type, transmission, body_type, colour,
              odometer_current, rego_state
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!v) return notFound('Vehicle')

    // Service record summary
    const [[svcSummary]] = await db.query<any[]>(
      `SELECT COUNT(*) AS service_count,
              MAX(COALESCE(i.odometer_in, vsl.odometer)) AS last_odometer,
              MAX(vsl.service_date) AS last_service_date,
              SUM(vsl.total) AS total_spend
       FROM vehicle_service_log vsl
       JOIN invoices i ON i.id = vsl.invoice_id
       WHERE vsl.vehicle_rego = (SELECT rego FROM vehicles WHERE id = ? LIMIT 1)`,
      [vehicleId],
    )

    const odometerKm = v.odometer_current ? Number(v.odometer_current) : null
    const serviceCount = svcSummary ? Number(svcSummary.service_count) : 0
    const totalSpend   = svcSummary?.total_spend ? Number(svcSummary.total_spend) : 0
    const lastService  = svcSummary?.last_service_date
      ? (svcSummary.last_service_date instanceof Date
          ? svcSummary.last_service_date.toISOString().slice(0, 10)
          : String(svcSummary.last_service_date).slice(0, 10))
      : null
    const age = new Date().getFullYear() - Number(v.year)

    const prompt = `You are a vehicle valuation expert for the Australian used car market. Search for current listings of this exact vehicle on carsales.com.au, Autotrader Australia, and Gumtree Australia to find what comparable cars are actually selling for right now, then provide a market value estimate.

## Vehicle to value
${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}
Body: ${v.body_type ?? 'unknown'} | Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}
Colour: ${v.colour ?? 'not specified'} | Registered in: ${v.rego_state}
Age: ${age} years
Odometer: ${odometerKm ? `${odometerKm.toLocaleString()} km` : 'unknown'}

## Service Record
Rodz workshop services on record: ${serviceCount}
Total spend at Rodz: $${totalSpend.toFixed(0)} AUD
Most recent service: ${lastService ?? 'unknown'}
${serviceCount > 0 ? 'This vehicle has a documented service history which adds value.' : 'No prior workshop service history on record.'}

Search for current Australian listings of this vehicle, then respond in this exact JSON format (no markdown, raw JSON only):
{
  "estimatedValueAud": {
    "low": <number>,
    "mid": <number>,
    "high": <number>
  },
  "comparableSales": [
    { "price": <number>, "odometer": <number or null>, "description": "<brief listing summary e.g. '2023 Toyota Corolla Ascent Sport, 28,000km, VIC'>" }
  ],
  "condition": "<excellent|good|fair|poor>",
  "conditionRationale": "<1 sentence explaining the condition assessment>",
  "keyFactors": [
    { "factor": "<factor name>", "impact": "<positive|negative|neutral>", "detail": "<brief explanation>" }
  ],
  "marketInsight": "<2-3 sentences on what you found in the current Australian market for this vehicle — mention actual price ranges seen>",
  "sellTips": ["<tip 1>", "<tip 2>", "<tip 3>"],
  "disclaimer": "This is an estimate based on current Australian listings. Actual sale price will vary based on vehicle condition, location, negotiation, and market timing."
}`

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      // @ts-ignore — googleSearch tool not yet in type definitions
      tools: [{ googleSearch: {} }],
      generationConfig: {
        maxOutputTokens: 1500,
        // @ts-ignore — thinkingConfig not yet in type definitions
        thinkingConfig: { thinkingBudget: 0 },
      },
    })

    const result = await model.generateContent(prompt)
    const raw    = result.response.text().trim()

    // Extract JSON from potential markdown code block
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
    const jsonText  = jsonMatch ? jsonMatch[1].trim() : raw.trim()

    let valuation: any
    try {
      valuation = JSON.parse(jsonText)
    } catch (parseErr) {
      console.error('Gemini parse error. Raw response:', raw.slice(0, 500))
      return serverError(new Error('Failed to parse valuation from AI'))
    }

    // Extract grounding sources if present
    const groundingMeta = (result.response as any).candidates?.[0]?.groundingMetadata
    const sources: string[] = []
    if (groundingMeta?.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web?.uri) sources.push(chunk.web.uri)
      }
    }

    return ok({
      vehicle: {
        year:        v.year,
        make:        v.make,
        model:       v.model,
        series:      v.series ?? null,
        odometerKm,
        serviceCount,
      },
      valuation,
      sources:     sources.length ? sources : undefined,
      generatedAt: new Date().toISOString().slice(0, 10),
    })
  } catch (err) {
    return serverError(err)
  }
}
