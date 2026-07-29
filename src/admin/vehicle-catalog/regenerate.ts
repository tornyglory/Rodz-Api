import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { badRequest, serverError, validationError } from '../../shared/errors'
import { CATALOG_YEAR_MIN, CATALOG_YEAR_MAX, okJson } from './_helpers'

// POST /admin/vehicle-catalog/regenerate
// Body: { year: number }
//
// Runs Gemini for the specified year, upserts additively into
// vehicle_makes / vehicle_models / vehicle_model_series. Never touches
// name / popular on existing rows (staff hand-edits are preserved);
// only extends year ranges on models & series.
//
// Sync execution — Lambda timeout 60s. Single year takes 10-20s
// including DB writes. Not suitable for full re-seeds (66 years);
// developers should run scripts/seed-vehicle-catalog.ts locally for
// bulk work.

const GEMINI_MODEL = 'gemini-2.5-flash'

interface GeminiSeries { slug: string; name: string; year_start?: number; year_end?: number; popular: boolean }
interface GeminiModel  { slug: string; name: string; popular: boolean; series?: GeminiSeries[] }
interface GeminiMake   { slug: string; name: string; popular: boolean; models: GeminiModel[] }

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

function slugify(raw: string | undefined | null): string {
  if (!raw) return ''
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function titleFromSlug(slug: string): string {
  return slug.split('-').map(w => w.length ? w[0].toUpperCase() + w.slice(1) : w).join(' ')
}

function promptForYear(year: number): string {
  return `List every passenger vehicle make sold new in Australia in ${year}, with their models available that year. Include commonly personally-imported vehicles that show up in Australian workshops (Mustang, Camaro, MG B, Alfa Giulia, Skyline R32/R34, Datsun 240Z etc.) as their real make.

Return a JSON array. Each element is an object with these fields — ALL required (slug, name, popular, models):
  - "slug"    : string  — lowercase ASCII, hyphenated, no punctuation.
  - "name"    : string  — human-readable make name.
  - "popular" : boolean
  - "models"  : array of model objects (slug, name, popular, optional series).

Each model object: (slug, name, popular) required, "series" optional array where the model has meaningful generation distinctions (Ford Falcon XA/XB/…, Nissan Skyline R32/R34, BMW 3 Series E30/E46/…, Toyota LandCruiser 40/60/70/80-series, Holden Commodore VB→VF, VW Golf Mk1→Mk8). Only include series current in ${year}.

Each series object: (slug, name, year_start, year_end, popular) — all required. Slug lowercase. Name as spoken.

Content rules:
- popular on makes: TRUE only for the top 8 makes by new-car market share in ${year}.
- popular on models: TRUE only for the top 3-5 of that make.
- No trim levels as separate rows.
- No trucks over 4.5t, no buses, no motorcycles.
- Ute / 4WD variants as separate models (HiLux, Ranger, LandCruiser 70/79/300).

Return ONLY the JSON array — no markdown, no explanation.`
}

interface MergedSeries { slug: string; name: string; yearStart: number; yearEnd: number; popular: boolean }
interface MergedModel  { slug: string; name: string; yearStart: number; yearEnd: number; popular: boolean; series: Map<string, MergedSeries> }
interface MergedMake   { slug: string; name: string; popular: boolean; models: Map<string, MergedModel> }

function mergeYear(year: number, rawMakes: GeminiMake[]): Map<string, MergedMake> {
  const makes = new Map<string, MergedMake>()
  const POPULAR_CUTOFF = 1990

  for (const m of rawMakes) {
    const makeSlug = slugify(m.slug || m.name)
    if (!makeSlug) continue
    let make: MergedMake = {
      slug: makeSlug,
      name: m.name?.trim() || titleFromSlug(makeSlug),
      popular: year >= POPULAR_CUTOFF && !!m.popular,
      models: new Map(),
    }
    makes.set(makeSlug, make)

    for (const md of m.models ?? []) {
      const modelSlug = slugify(md.slug || md.name)
      if (!modelSlug) continue
      const mm: MergedModel = {
        slug: modelSlug,
        name: md.name?.trim() || titleFromSlug(modelSlug),
        yearStart: year,
        yearEnd:   year,
        popular:   year >= POPULAR_CUTOFF && !!md.popular,
        series: new Map(),
      }
      make.models.set(modelSlug, mm)

      for (const s of md.series ?? []) {
        const seriesSlug = slugify(s.slug || s.name)
        if (!seriesSlug) continue
        const yStart = Number.isInteger(s.year_start) ? Number(s.year_start) : year
        const yEnd   = Number.isInteger(s.year_end)   ? Number(s.year_end)   : year
        mm.series.set(seriesSlug, {
          slug: seriesSlug,
          name: s.name?.trim() || titleFromSlug(seriesSlug),
          yearStart: yStart,
          yearEnd:   yEnd,
          popular:   !!s.popular,
        })
      }
    }
  }
  return makes
}

interface UpsertCounts {
  makes:  { inserted: number; existing: number }
  models: { inserted: number; extended: number; unchanged: number }
  series: { inserted: number; extended: number; unchanged: number }
}

async function upsert(db: mysql.Pool, makes: Map<string, MergedMake>): Promise<UpsertCounts> {
  const counts: UpsertCounts = {
    makes:  { inserted: 0, existing: 0 },
    models: { inserted: 0, extended: 0, unchanged: 0 },
    series: { inserted: 0, extended: 0, unchanged: 0 },
  }

  for (const make of Array.from(makes.values())) {
    const [makeRes] = await db.query<any>(
      `INSERT INTO vehicle_makes (slug, name, popular) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [make.slug, make.name, make.popular ? 1 : 0],
    )
    let makeId = Number((makeRes as any).insertId ?? 0)
    if (!makeId) {
      const [[row]] = await db.query<any[]>('SELECT id FROM vehicle_makes WHERE slug = ? LIMIT 1', [make.slug])
      makeId = Number(row?.id ?? 0)
      counts.makes.existing++
    } else {
      counts.makes.inserted++
    }
    if (!makeId) continue

    for (const mm of Array.from(make.models.values())) {
      const [modelRes] = await db.query<any>(
        `INSERT INTO vehicle_models (make_id, slug, name, year_start, year_end, popular)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             year_start = LEAST(year_start, VALUES(year_start)),
             year_end   = GREATEST(year_end, VALUES(year_end))`,
        [makeId, mm.slug, mm.name, mm.yearStart, mm.yearEnd, mm.popular ? 1 : 0],
      )
      const aff = Number((modelRes as any).affectedRows ?? 0)
      if (aff === 1) counts.models.inserted++
      else if (aff === 2) counts.models.extended++
      else counts.models.unchanged++
      let modelId = Number((modelRes as any).insertId ?? 0)
      if (!modelId) {
        const [[row]] = await db.query<any[]>(
          'SELECT id FROM vehicle_models WHERE make_id = ? AND slug = ? LIMIT 1', [makeId, mm.slug])
        modelId = Number(row?.id ?? 0)
      }
      if (!modelId) continue

      for (const ss of Array.from(mm.series.values())) {
        const [sRes] = await db.query<any>(
          `INSERT INTO vehicle_model_series (model_id, slug, name, year_start, year_end, popular)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               year_start = LEAST(year_start, VALUES(year_start)),
               year_end   = GREATEST(year_end, VALUES(year_end))`,
          [modelId, ss.slug, ss.name, ss.yearStart, ss.yearEnd, ss.popular ? 1 : 0],
        )
        const sa = Number((sRes as any).affectedRows ?? 0)
        if (sa === 1) counts.series.inserted++
        else if (sa === 2) counts.series.extended++
        else counts.series.unchanged++
      }
    }
  }

  return counts
}

export async function regenerate(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const year = Number(body.year)
    if (!Number.isInteger(year) || year < CATALOG_YEAR_MIN || year > CATALOG_YEAR_MAX) {
      return validationError(`year must be an integer between ${CATALOG_YEAR_MIN} and ${CATALOG_YEAR_MAX}.`)
    }
    if (!process.env.GEMINI_API_KEY) {
      return serverError(new Error('GEMINI_API_KEY not configured'))
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: 'application/json' },
    })

    const res = await model.generateContent(promptForYear(year))
    const text = stripFences(res.response.text())
    const parsed = JSON.parse(text) as GeminiMake[] | { makes?: GeminiMake[] }
    const rawMakes: GeminiMake[] = Array.isArray(parsed) ? parsed : (parsed.makes ?? [])

    const merged = mergeYear(year, rawMakes)
    const totalModels = Array.from(merged.values()).reduce((n, m) => n + m.models.size, 0)
    const totalSeries = Array.from(merged.values())
      .flatMap(m => Array.from(m.models.values()))
      .reduce((n, mm) => n + mm.series.size, 0)

    const upsertCounts = await upsert(db, merged)

    return okJson({
      year,
      gemini: {
        makes:  merged.size,
        models: totalModels,
        series: totalSeries,
      },
      upsert: upsertCounts,
    })
  } catch (err) {
    return serverError(err)
  }
}

// Deprecated re-export in case any callers reference the module-level default.
export { regenerate as handler }
