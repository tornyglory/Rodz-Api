import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/vehicle-catalog/overview?year=YYYY&make=slug&model=slug&km=NNN
//
// The guest booking flow's "we know your car" wow-moment payload.
//   - year+make+model alone → intro + displayName + empty preview.
//   - year+make+model+km   → adds personalisedIntro + genericMaintenancePreview
//                            when we have a vehicle_model_profiles row.
//
// Gracefully degrades: unknown make/model or missing profile → 200 with
// nulls, never 404. Only bad-shape input (missing year, negative km)
// returns 400.
//
// This endpoint is called by JS on the guest booking page — not by
// crawlers — so the duplicate-content policy that governs the
// /vehicle/{token} SSR endpoint does not apply here. common_repairs
// and other shared per-model data are safe to surface.

interface GenericRepair {
  name?:          string
  intervalKm?:    number | null
  typicalCostAud?: number | null
}

interface MaintenanceItem {
  atKm:     number
  task:     string
  priority: 'recommended' | 'watch'
}

function kmDisplay(km: number): string {
  if (km >= 1000) {
    const k = km / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  return String(km)
}

function ceilMultiple(km: number, interval: number): number {
  if (km <= 0) return interval
  return Math.ceil(km / interval) * interval
}

export function shapeMaintenance(
  common: GenericRepair[] | null | undefined,
  km: number,
  limit = 5,
): MaintenanceItem[] {
  if (!Array.isArray(common)) return []
  const items: MaintenanceItem[] = []
  for (const c of common) {
    if (!c?.name) continue
    const interval = Number(c.intervalKm ?? 0)
    if (!Number.isInteger(interval) || interval <= 0) continue
    const atKm = ceilMultiple(km, interval)
    const priority: MaintenanceItem['priority'] =
      atKm - km <= 10000 ? 'recommended' : 'watch'
    items.push({ atKm, task: c.name, priority })
  }
  items.sort((a, b) => a.atKm - b.atKm)
  return items.slice(0, limit)
}

function shapeIntro(year: number, makeName: string, modelName: string): string {
  const opener = year < 1990 ? 'Sweet' : 'Nice'
  const classic = year < 1990 ? ' classic' : ''
  return `${opener} —${classic} a ${year} ${makeName} ${modelName}.`
}

function shapePersonalisedIntro(
  modelName: string,
  km: number,
  preview: MaintenanceItem[],
): string | null {
  const dueSoon = preview.filter(p => p.priority === 'recommended').slice(0, 3)
  if (dueSoon.length === 0) return null
  const tasks = dueSoon.map(p => p.task.toLowerCase()).join(', ')
  return `With ${kmDisplay(km)} on the clock, ${modelName}s at this mileage are typically due for ${tasks}.`
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const q = event.queryStringParameters ?? {}
  const year = Number(q.year)
  const makeSlug  = (q.make  ?? '').trim().toLowerCase()
  const modelSlug = (q.model ?? '').trim().toLowerCase()
  const hasKm = q.km != null && q.km !== ''
  const km = hasKm ? Number(q.km) : null

  if (!q.year || !Number.isInteger(year) || year < 1900 || year > 2100) {
    return badRequest('year query param is required and must be a valid year.')
  }
  if (!makeSlug)  return badRequest('make query param is required.')
  if (!modelSlug) return badRequest('model query param is required.')
  if (hasKm && (!Number.isFinite(km) || (km as number) < 0)) {
    return badRequest('km must be a non-negative number when provided.')
  }

  try {
    const [[mo]] = await db.query<any[]>(
      `SELECT mo.id AS model_id, mo.name AS model_name, mo.slug AS model_slug,
              mk.id AS make_id,  mk.name AS make_name,  mk.slug AS make_slug
       FROM vehicle_models mo
       JOIN vehicle_makes mk ON mk.id = mo.make_id
       WHERE mk.slug = ? AND mo.slug = ?
       LIMIT 1`,
      [makeSlug, modelSlug],
    )

    // Graceful degradation — unknown make/model still returns 200 so the
    // frontend can render step 4 with a generic "OK — a {year} {input}, let's grab a few details."
    // The client sees `displayName: null` and knows to fall back to whatever the user typed.
    if (!mo) {
      return jsonOk({
        year,
        make:  makeSlug,
        model: modelSlug,
        ...(hasKm ? { km } : {}),
        displayName:             null,
        intro:                   null,
        personalisedIntro:       null,
        suggestedServiceTypeIds: [],
        genericMaintenancePreview: [],
      }, hasKm)
    }

    const displayName = `${year} ${mo.make_name} ${mo.model_name}`
    const intro = shapeIntro(year, mo.make_name, mo.model_name)

    // Look up the shared per-(make, model, year) profile — nearest year in
    // ±3 to accept slight schema drift (a 2017 Vitara profile is fine for
    // a 2016 or 2018 request if the exact year isn't cached).
    const [[profile]] = await db.query<any[]>(
      `SELECT common_repairs
       FROM vehicle_model_profiles
       WHERE make = ? AND model = ? AND year BETWEEN ? AND ?
       ORDER BY ABS(year - ?) ASC
       LIMIT 1`,
      [mo.make_name, mo.model_name, year - 3, year + 3, year],
    )

    let maintenance: MaintenanceItem[] = []
    let personalisedIntro: string | null = null

    if (profile && hasKm && km != null) {
      const commonRepairs: GenericRepair[] = Array.isArray(profile.common_repairs)
        ? profile.common_repairs
        : (typeof profile.common_repairs === 'string'
            ? (JSON.parse(profile.common_repairs) as GenericRepair[])
            : [])
      maintenance = shapeMaintenance(commonRepairs, km)
      personalisedIntro = shapePersonalisedIntro(mo.model_name, km, maintenance)
    }

    return jsonOk({
      year,
      make:  mo.make_slug,
      model: mo.model_slug,
      ...(hasKm ? { km } : {}),
      displayName,
      intro,
      personalisedIntro,
      // Deferred — mapping common_repairs to workshop service_types.id is
      // a separate design pass. Empty array is the shipping default.
      suggestedServiceTypeIds: [],
      genericMaintenancePreview: maintenance,
    }, hasKm)
  } catch (err) {
    return serverError(err)
  }
}

function jsonOk(body: unknown, hasKm: boolean): APIGatewayProxyResultV2 {
  // Personalised responses vary by km, so shorter cache; generic
  // responses (year/make/model only) can cache longer.
  const cacheControl = hasKm
    ? 'public, max-age=600, s-maxage=3600'
    : 'public, max-age=3600, s-maxage=86400'
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    body: JSON.stringify(body),
  }
}
