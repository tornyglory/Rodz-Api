import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

const ready = bootstrap()

export interface RecommendationEngineEvent {
  vehicleId: number
  customerId: number
}

interface GeminiRecommendation {
  title:            string
  body:             string
  urgency:          'advisory' | 'recommended' | 'important' | 'urgent'
  estimatedDueKm:   number | null
  estimatedCostMin: number | null
  estimatedCostMax: number | null
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

const VALID_URGENCY = new Set(['advisory', 'recommended', 'important', 'urgent'])

async function getRecommendations(vehicle: any): Promise<GeminiRecommendation[]> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const parts = [
    `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    vehicle.series     ? vehicle.series                          : null,
    vehicle.engine_code ? `engine ${vehicle.engine_code}`       : null,
    vehicle.engine_size_cc ? `${vehicle.engine_size_cc}cc`      : null,
    vehicle.fuel_type  ? vehicle.fuel_type                      : null,
    vehicle.transmission ? vehicle.transmission                 : null,
  ].filter(Boolean).join(', ')

  const odometerLine = vehicle.odometer_current
    ? `Current odometer: ${vehicle.odometer_current.toLocaleString()} km`
    : 'Current odometer: unknown'

  const intervalLine = vehicle.service_interval_km
    ? `Manufacturer service interval: every ${vehicle.service_interval_km.toLocaleString()} km or ${vehicle.service_interval_months ?? '?'} months`
    : ''

  const prompt = `You are an Australian automotive expert.

Vehicle: ${parts}
${odometerLine}
${intervalLine}

Return a JSON array of preventative maintenance recommendations for this specific vehicle.

Each item must have exactly these fields:
- "title": short service name, max 60 characters
- "body": 2-3 sentences explaining why this matters for THIS specific vehicle, written for the customer in plain English. Mention the vehicle by make/model where natural.
- "urgency": one of "advisory", "recommended", "important", "urgent"
- "estimatedDueKm": integer km when this service is due based on current odometer, or null for age/time-based items
- "estimatedCostMin": estimated cost in AUD as integer, or null
- "estimatedCostMax": estimated cost in AUD as integer, or null

Rules:
- Be specific to this exact vehicle. If this engine has a timing chain (not belt), do not include a timing belt item.
- Include items due within the next 15,000 km or that are overdue.
- Include age-related items (battery, tyres, wiper blades, air conditioning) regardless of odometer.
- Include any known failure points or common issues specific to this make/model/year.
- Focus on Australian driving conditions and climate.
- Do not include generic items that clearly do not apply to this vehicle (e.g. no spark plugs for a diesel).
- Return JSON array only, no markdown, no explanation.`

  const result = await model.generateContent(prompt)
  const parsed = JSON.parse(stripFences(result.response.text()))

  if (!Array.isArray(parsed)) return []

  return parsed
    .filter((r: any) => r.title && r.body && VALID_URGENCY.has(r.urgency))
    .map((r: any) => ({
      title:            String(r.title).slice(0, 60),
      body:             String(r.body).slice(0, 500),
      urgency:          r.urgency as GeminiRecommendation['urgency'],
      estimatedDueKm:   r.estimatedDueKm   ? Number(r.estimatedDueKm)   : null,
      estimatedCostMin: r.estimatedCostMin ? Number(r.estimatedCostMin) : null,
      estimatedCostMax: r.estimatedCostMax ? Number(r.estimatedCostMax) : null,
    }))
}

export const handler = async (event: RecommendationEngineEvent): Promise<void> => {
  await ready
  const db = getPool()
  const { vehicleId, customerId } = event

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT make, model, series, year, fuel_type, transmission,
              engine_code, engine_size_cc,
              odometer_current, service_interval_km, service_interval_months
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!vehicle) return

    const recommendations = await getRecommendations(vehicle)
    if (recommendations.length === 0) return

    for (const rec of recommendations) {
      await db.query(
        `INSERT INTO ai_recommendations
           (vehicle_id, customer_id, rule_id, title, recommendation_body, urgency,
            triggered_at_odometer, triggered_at_date, estimated_due_odometer,
            estimated_cost_min, estimated_cost_max, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, CURDATE(), ?, ?, ?, NOW(), NOW())`,
        [
          vehicleId,
          customerId,
          rec.title,
          rec.body.slice(0, 150),
          rec.urgency,
          vehicle.odometer_current ?? null,
          rec.estimatedDueKm       ?? null,
          rec.estimatedCostMin     ?? null,
          rec.estimatedCostMax     ?? null,
        ],
      )
    }

    console.log(`RecommendationEngine: wrote ${recommendations.length} recommendation(s) for vehicle ${vehicleId}`)
  } catch (err) {
    console.error('RecommendationEngine error:', err)
    throw err
  }
}
