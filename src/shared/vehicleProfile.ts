import mysql from 'mysql2/promise'
import type { Tone } from './descriptionEnhance'

// Response shape used by every profile GET (public magic-link, staff,
// and the regenerate handler). One place to keep the wire contract.
export interface VehicleProfileResponse {
  status:        'ready'
  make:          string
  model:         string
  year:          number
  generatedAt:   string
  tone?:         Tone
  overview:      string
  engineSpecs:   unknown
  tyreSpecs:     unknown
  serviceNotes:  unknown
  knownIssues:   unknown
  commonRepairs: unknown
}

// Structured (per-model) fields stay in vehicle_model_profiles;
// voice-bearing fields (overview, serviceNotes, knownIssues) can be
// overridden per-vehicle via vehicle_profile_overrides. This helper
// resolves both in a single call so every read path stays in sync.
export async function loadProfileForVehicle(
  db: mysql.Pool,
  vehicle: { id: number | string; make: string; model: string; year: number },
): Promise<{ base: any | null; override: any | null }> {
  const [[base]] = await db.query<any[]>(
    `SELECT overview, engine_specs, tyre_specs, service_notes, known_issues,
            common_repairs, generated_at
     FROM vehicle_model_profiles
     WHERE make = ? AND model = ? AND year = ?
     LIMIT 1`,
    [vehicle.make, vehicle.model, vehicle.year],
  )
  if (!base) return { base: null, override: null }

  const [[override]] = await db.query<any[]>(
    `SELECT tone, overview, service_notes, known_issues, regenerated_at
     FROM vehicle_profile_overrides
     WHERE vehicle_id = ?
     LIMIT 1`,
    [vehicle.id],
  )
  return { base, override: override ?? null }
}

// Merge the base row + optional override into the wire shape. The override
// only supplies the voice-bearing fields; structured fields always come
// from the base. `generatedAt` reflects the most recent write (base OR
// override) so cache-busting and freshness readouts stay honest.
export function shapeProfile(
  vehicle: { make: string; model: string; year: number },
  base: any,
  override: any | null,
): VehicleProfileResponse {
  const generatedAt = override?.regenerated_at
    ? new Date(override.regenerated_at).toISOString()
    : new Date(base.generated_at).toISOString()

  return {
    status:        'ready',
    make:          vehicle.make,
    model:         vehicle.model,
    year:          vehicle.year,
    generatedAt,
    ...(override?.tone ? { tone: override.tone as Tone } : {}),
    overview:      override?.overview      ?? base.overview,
    engineSpecs:   base.engine_specs,
    tyreSpecs:     base.tyre_specs,
    serviceNotes:  override?.service_notes ?? base.service_notes,
    knownIssues:   override?.known_issues  ?? base.known_issues,
    commonRepairs: base.common_repairs,
  }
}
