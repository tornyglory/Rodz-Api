import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

const ready = bootstrap()

export interface VehicleProfileEngineEvent {
  vehicleId: number
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

async function generateProfile(vehicle: any): Promise<any> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const parts = [
    `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    vehicle.series       ? vehicle.series                    : null,
    vehicle.engine_code  ? `engine ${vehicle.engine_code}`  : null,
    vehicle.engine_size_cc ? `${vehicle.engine_size_cc}cc`  : null,
    vehicle.fuel_type    ? vehicle.fuel_type                 : null,
    vehicle.transmission ? vehicle.transmission              : null,
  ].filter(Boolean).join(', ')

  const prompt = `You are an experienced Australian automotive mechanic and workshop manager. Generate a concise reference profile for this vehicle that will help technicians service it correctly without needing to look anything up.

Vehicle: ${parts}

Return a JSON object only, no markdown, with this exact structure:
{
  "overview": "2-3 sentences: what kind of vehicle this is, its reputation for reliability, and anything a mechanic should know before starting work on it",
  "engineSpecs": {
    "oilType": "e.g. 5W-30 full synthetic",
    "oilCapacityL": 4.5,
    "coolantType": "e.g. Toyota SLLC (pink/red) — do not mix with green",
    "transmissionFluid": "e.g. Toyota ATF WS (sealed, no dipstick)" or null,
    "brakeFluid": "e.g. DOT 3",
    "powerSteeringFluid": "e.g. Dexron III ATF" or null,
    "sparkPlugType": "e.g. NGK ILZKR7B11" or null,
    "sparkPlugIntervalKm": 100000 or null,
    "timingDrive": "chain" or "belt" or "gear",
    "timingBeltIntervalKm": 100000 or null
  },
  "tyreSpecs": {
    "front": { "size": "205/55R16", "pressureCold": "240 kPa / 35 psi" },
    "rear":  { "size": "205/55R16", "pressureCold": "240 kPa / 35 psi" },
    "spare": "space saver / full-size / run-flat / no spare"
  },
  "serviceNotes": [
    "Short bullet-point notes about quirks, gotchas, or things commonly missed — e.g. 'Requires Toyota-specific coolant, do not use universal green', 'Drain plug is aluminium — 25 Nm max torque'"
  ],
  "knownIssues": [
    {
      "title": "Short issue name",
      "description": "What it is, symptoms, and what to check for — plain English, max 120 chars",
      "severity": "low" or "medium" or "high"
    }
  ],
  "commonRepairs": [
    {
      "name": "Short repair name",
      "intervalKm": 60000 or null,
      "typicalCostAud": 350
    }
  ]
}

Be specific to this exact make/model/year/engine. Do not give generic advice. If a value is unknown or not applicable, use null.`

  const result = await model.generateContent(prompt)
  return JSON.parse(stripFences(result.response.text()))
}

export const handler = async (event: VehicleProfileEngineEvent): Promise<void> => {
  await ready
  const db = getPool()
  const { vehicleId } = event

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT make, model, series, year, fuel_type, transmission,
              engine_code, engine_size_cc
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!vehicle) return

    // Shared profile per make/model/year — skip if already generated
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicle_model_profiles WHERE make = ? AND model = ? AND year = ? LIMIT 1',
      [vehicle.make, vehicle.model, vehicle.year],
    )
    if (existing) return

    const profile = await generateProfile(vehicle)

    await db.query(
      `INSERT INTO vehicle_model_profiles
         (make, model, year, overview, engine_specs, tyre_specs, service_notes, known_issues, common_repairs, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         overview       = VALUES(overview),
         engine_specs   = VALUES(engine_specs),
         tyre_specs     = VALUES(tyre_specs),
         service_notes  = VALUES(service_notes),
         known_issues   = VALUES(known_issues),
         common_repairs = VALUES(common_repairs),
         generated_at   = NOW()`,
      [
        vehicle.make,
        vehicle.model,
        vehicle.year,
        profile.overview       ?? '',
        JSON.stringify(profile.engineSpecs    ?? {}),
        JSON.stringify(profile.tyreSpecs      ?? {}),
        JSON.stringify(profile.serviceNotes   ?? []),
        JSON.stringify(profile.knownIssues    ?? []),
        JSON.stringify(profile.commonRepairs  ?? []),
      ],
    )

    console.log(`VehicleProfileEngine: generated profile for ${vehicle.year} ${vehicle.make} ${vehicle.model}`)
  } catch (err) {
    console.error('VehicleProfileEngine error:', err)
    throw err
  }
}
