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
  serviceTypeId:    number | null
  partNameIds:      number[]
}

interface ServiceTypeChoice {
  id:                    number
  name:                  string
  category:              string
  labour_hours_estimate: number
  fixed_price:           number | null
}

interface PartNameChoice {
  id:       number
  name:     string
  category: string
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

const VALID_URGENCY = new Set(['advisory', 'recommended', 'important', 'urgent'])

async function loadServiceTypes(db: import('mysql2/promise').Pool): Promise<ServiceTypeChoice[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, name, category, labour_hours_estimate, fixed_price
     FROM service_types
     WHERE is_active = 1 AND is_bookable = 1
     ORDER BY category, name`,
  )
  return rows.map(r => ({
    id:                    Number(r.id),
    name:                  String(r.name),
    category:              String(r.category),
    labour_hours_estimate: Number(r.labour_hours_estimate),
    fixed_price:           r.fixed_price != null ? Number(r.fixed_price) : null,
  }))
}

async function loadPartNames(db: import('mysql2/promise').Pool): Promise<PartNameChoice[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, name, category
     FROM part_names
     WHERE is_active = 1
     ORDER BY category, name`,
  )
  return rows.map(r => ({
    id:       Number(r.id),
    name:     String(r.name),
    category: String(r.category ?? 'Other'),
  }))
}

async function getRecommendations(
  vehicle: any,
  currentKm: number,
  services: ServiceTypeChoice[],
  partNames: PartNameChoice[],
): Promise<GeminiRecommendation[]> {
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

  // Compact one-line-per-service list so the LLM can pick the best FK
  // without eating tokens. Highlight the catch-all so the LLM sees it
  // clearly and uses it for bookable-but-unmatched tasks (rather than
  // returning null, which strips the customer's "Book this" button).
  const catchAll  = services.find(s => s.name.toLowerCase().startsWith('something else'))
  const specifics = services.filter(s => s !== catchAll)
  const servicesList = specifics
    .map(s => `- id ${s.id} | ${s.category} | ${s.name} | ${s.labour_hours_estimate}h${s.fixed_price != null ? ` | fixed $${s.fixed_price}` : ''}`)
    .join('\n')
  const catchAllLine = catchAll
    ? `\n\nCATCH-ALL (use this when the task is bookable but no specific service above fits):\n- id ${catchAll.id} | ${catchAll.category} | ${catchAll.name}`
    : ''
  const validIds = new Set(services.map(s => s.id))

  // Group part_names by category for a compact, LLM-friendly layout.
  // ~322 rows × ~15 tokens each = ~5k tokens — negligible against the
  // cost of a full-schedule generation.
  const partsByCat = new Map<string, PartNameChoice[]>()
  for (const p of partNames) {
    const arr = partsByCat.get(p.category) ?? []
    arr.push(p)
    partsByCat.set(p.category, arr)
  }
  const partsList = Array.from(partsByCat.entries())
    .map(([cat, arr]) =>
      `[${cat}]\n${arr.map(p => `  ${p.id}: ${p.name}`).join('\n')}`
    ).join('\n\n')
  const validPartIds = new Set(partNames.map(p => p.id))

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

SERVICES OFFERED BY THIS WORKSHOP:
${servicesList}${catchAllLine}

For each recommendation, include "serviceTypeId":
- Pick the id from the specific-service list above that best matches this task.
- Prefer the specific service over the generic one when both fit (e.g. "Brake Fluid Flush" over a general service).
- If the task IS a bookable workshop job but no specific service above fits (e.g. spark plug replacement, wiper blade replacement, coolant flush, drive belt inspection, hybrid battery check), use the CATCH-ALL id above. The customer's booking will land with the recommendation title copied into notes so the workshop knows exactly what to do.
- Use null ONLY for observation-only or habitual items the customer does themselves — e.g. "Monitor oil consumption between services" (a check they do at home), "Tyre pressure check & top-up monthly" (a habit, not a workshop visit), "Look for warning lights". If a mechanic would ever perform this task, prefer the catch-all over null.
- The customer will click "Book this" on the recommendation, so accuracy matters — a wrong id pre-fills the wrong service.

STANDARDISED PART CATALOGUE (grouped by category):
${partsList}

For each recommendation, include "partNameIds" — an array of ids from the catalogue above listing the parts a workshop would typically replace or top up for THIS specific task on THIS specific vehicle:
- Pick only parts that the workshop physically buys/consumes for the task. Not tools, not labour, not consumables like rags.
- Be vehicle-appropriate. A diesel needs a diesel fuel filter (id 357), a petrol doesn't. A hybrid battery inspection (id 469) doesn't apply to a non-hybrid.
- Include commonly-paired parts. A timing belt service usually gets a Water Pump too — include both if the workshop would do both together on this vehicle. An oil service gets Engine Oil + Oil Filter.
- Include obviously optional/conditional parts only when they are commonly done alongside — the frontend surfaces them without singling out optionality.
- For monitoring/observation recommendations that involve no parts (e.g. "Look for warning lights", "Monitor oil consumption"), use an empty array [].
- IDs must come from the catalogue above — do not invent ids.

Return a JSON array only, no markdown:
[
  {
    "title": "Oil & Filter Change",
    "body": "Your M15A engine needs clean oil to protect its variable valve timing system (VVT). Dirty oil causes VVT sludge build-up which leads to rough idle and expensive head work. This engine is also known to use a little oil between services — worth checking the dipstick monthly. Use 5W-30 semi-synthetic.",
    "urgency": "recommended",
    "estimatedDueKm": 60000,
    "estimatedCostMin": 120,
    "estimatedCostMax": 180,
    "serviceTypeId": 1,
    "partNameIds": [385, 354]
  },
  {
    "title": "Spark Plug Replacement",
    "body": "Iridium spark plugs are worn by this point — replacing them keeps combustion clean, protects the catalytic converter, and restores fuel economy.",
    "urgency": "recommended",
    "estimatedDueKm": 100000,
    "estimatedCostMin": 250,
    "estimatedCostMax": 400,
    "serviceTypeId": ${catchAll ? catchAll.id : 'null'},
    "partNameIds": []
  },
  {
    "title": "Monitor Engine Oil Consumption",
    "body": "This engine can consume a small amount of oil between services. Check the dipstick monthly and top up with the same 5W-30 if it drops below the minimum mark.",
    "urgency": "advisory",
    "estimatedDueKm": null,
    "estimatedCostMin": null,
    "estimatedCostMax": null,
    "serviceTypeId": null,
    "partNameIds": []
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
    .map((r: any) => {
      // Guard against hallucinated ids — the LLM occasionally picks a
      // number that isn't in the active list. Fall back to null so the
      // frontend renders the generic "Book a service" button instead of
      // preselecting the wrong one.
      const rawId = r.serviceTypeId != null ? Number(r.serviceTypeId) : null
      const serviceTypeId = rawId != null && validIds.has(rawId) ? rawId : null

      // Validate + dedupe the parts array. Hallucinated ids drop silently
      // — they just wouldn't render on the frontend anyway.
      const partNameIds = Array.isArray(r.partNameIds)
        ? Array.from(new Set(
            (r.partNameIds as unknown[])
              .map(v => Number(v))
              .filter(n => Number.isFinite(n) && validPartIds.has(n))
          )).slice(0, 12)
        : []

      return {
        title:            String(r.title).slice(0, 60),
        body:             String(r.body).slice(0, 500),
        urgency:          r.urgency as GeminiRecommendation['urgency'],
        estimatedDueKm:   r.estimatedDueKm   ? Number(r.estimatedDueKm)   : null,
        estimatedCostMin: r.estimatedCostMin ? Number(r.estimatedCostMin) : null,
        estimatedCostMax: r.estimatedCostMax ? Number(r.estimatedCostMax) : null,
        serviceTypeId,
        partNameIds,
      }
    })
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
    const [services, partNames] = await Promise.all([
      loadServiceTypes(db),
      loadPartNames(db),
    ])

    const recommendations = await getRecommendations(vehicle, currentKm, services, partNames)
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
           (vehicle_id, customer_id, rule_id, service_type_id, part_name_ids, title, recommendation_title, recommendation_body, urgency,
            triggered_at_odometer, triggered_at_date, estimated_due_odometer,
            estimated_cost_min, estimated_cost_max, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, NOW(), NOW())`,
        [
          vehicleId,
          customerId,
          rec.serviceTypeId,
          rec.partNameIds.length ? JSON.stringify(rec.partNameIds) : null,
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
