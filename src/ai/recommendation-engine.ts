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

async function getRecommendations(vehicle: any, currentKm: number): Promise<GeminiRecommendation[]> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const parts = [
    `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    vehicle.series      ? vehicle.series                     : null,
    vehicle.engine_code ? `engine ${vehicle.engine_code}`   : null,
    vehicle.engine_size_cc ? `${vehicle.engine_size_cc}cc`  : null,
    vehicle.fuel_type   ? vehicle.fuel_type                 : null,
    vehicle.transmission ? vehicle.transmission              : null,
  ].filter(Boolean).join(', ')

  const prompt = `You are an Australian automotive expert and educator building a complete lifetime maintenance schedule for a customer who wants to understand and properly look after their vehicle.

Vehicle: ${parts}
Current odometer: ${currentKm.toLocaleString()} km

Generate a complete maintenance schedule from ${currentKm} km to 250,000 km. This schedule will be sent to the customer as a series of personalised emails — each one should teach them something real about their car.

CRITICAL RULES — READ CAREFULLY:
1. List EVERY individual service occurrence separately in km order. Do not group or summarise recurring items. If oil is due every 15,000 km, include a separate entry at each interval all the way to 250,000 km.
2. Use the CORRECT manufacturer-specified intervals for this exact vehicle and engine. A Porsche 911 Turbo S has very different intervals to a Toyota Corolla — get them right.
3. Include ALL known real-world failure points specific to this make/model/year — things mechanics actually see. Include the km range they typically appear. If there are TSBs, common faults, or owner-reported issues, include them.
4. Order by estimatedDueKm ascending. Items with no km trigger (age/condition-based) go at the end with estimatedDueKm: null.
5. Australian conditions: heat, UV exposure, and dust affect rubber, fluids, and batteries faster than European or US estimates.

For the "body" field — write 2-4 sentences that educate the customer:
- What this service involves and why it matters for THIS specific engine or model
- What happens to their car if they skip or delay it
- Any specific thing they should know about this vehicle (e.g. "The M15A engine is known to consume oil slightly — check your level between services")
- Keep it plain English, like a trusted mechanic talking to a customer
- Max 500 characters

Return a JSON array only, no markdown:
[
  {
    "title": "Oil & Filter Change",
    "body": "Your M15A engine needs clean oil to protect its variable valve timing system (VVT). Dirty oil causes VVT sludge build-up which leads to rough idle and expensive head work. This engine is also known to use a little oil between services — worth checking the dipstick monthly. Use 5W-30 semi-synthetic.",
    "urgency": "recommended",
    "estimatedDueKm": 60000,
    "estimatedCostMin": 120,
    "estimatedCostMax": 180
  }
]

urgency values: "advisory" | "recommended" | "important" | "urgent"
Set estimatedDueKm to null only for purely age or condition-based items with no km trigger.`

  const result = await model.generateContent(prompt)
  const text   = result.response.text()
  const parsed = JSON.parse(stripFences(text))

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

    const currentKm = vehicle.odometer_current ?? 0

    const recommendations = await getRecommendations(vehicle, currentKm)
    if (recommendations.length === 0) {
      console.log(`RecommendationEngine: Gemini returned no recommendations for vehicle ${vehicleId}`)
      return
    }

    // Rebuild the active schedule from scratch on every run
    await db.query(
      `DELETE FROM ai_recommendations WHERE vehicle_id = ? AND status = 'active'`,
      [vehicleId],
    )

    for (const rec of recommendations) {
      await db.query(
        `INSERT INTO ai_recommendations
           (vehicle_id, customer_id, rule_id, title, recommendation_title, recommendation_body, urgency,
            triggered_at_odometer, triggered_at_date, estimated_due_odometer,
            estimated_cost_min, estimated_cost_max, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, NOW(), NOW())`,
        [
          vehicleId,
          customerId,
          rec.title,
          rec.title,
          rec.body,
          rec.urgency,
          currentKm,
          rec.estimatedDueKm   ?? null,
          rec.estimatedCostMin ?? null,
          rec.estimatedCostMax ?? null,
        ],
      )
    }

    console.log(`RecommendationEngine: wrote ${recommendations.length} recommendations for vehicle ${vehicleId}`)
  } catch (err) {
    console.error('RecommendationEngine error:', err)
    throw err
  }
}
