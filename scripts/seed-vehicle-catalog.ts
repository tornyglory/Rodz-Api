// Seed the public vehicle catalog (vehicle_makes + vehicle_models) via
// Gemini. Batch-by-year from 1960 to the current year. Additive-only —
// re-runs never clobber a hand-edited row, they only extend year ranges
// and insert rows that don't exist yet.
//
// Usage:
//   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=rodz \
//   GEMINI_API_KEY=... \
//   npx tsx scripts/seed-vehicle-catalog.ts [--year 2017] [--dry-run]
//
// Flags:
//   --year N       Seed only that single year (repeatable? no — one year only).
//                  Handy for re-running a specific year without re-doing everything.
//   --dry-run      Fetch + parse but don't write to the DB. Prints what would happen.
//
// The tail of the run also prints a "mismatch report" — real customer
// vehicles whose (make, model, year) doesn't line up with the catalog.
// Staff hand-fixes those via the admin UI (step 3 of the rollout).

import 'dotenv/config'
import * as mysql from 'mysql2/promise'
import { GoogleGenerativeAI } from '@google/generative-ai'

const YEAR_FLOOR      = 1960
const CURRENT_YEAR    = new Date().getFullYear()
const POPULAR_CUTOFF  = 1990                    // popular flags forced false below this
const CONCURRENCY     = 3                       // parallel Gemini calls (rate-limit friendly)
const GEMINI_MODEL    = 'gemini-2.5-flash'

// ── Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const singleYear = (() => {
  const i = args.indexOf('--year')
  if (i === -1) return null
  const n = Number(args[i + 1])
  if (!Number.isInteger(n) || n < YEAR_FLOOR || n > CURRENT_YEAR + 1) {
    console.error(`--year must be between ${YEAR_FLOOR} and ${CURRENT_YEAR + 1}`)
    process.exit(1)
  }
  return n
})()

const years = singleYear
  ? [singleYear]
  : Array.from({ length: CURRENT_YEAR - YEAR_FLOOR + 1 }, (_, i) => YEAR_FLOOR + i)

// ── Types ───────────────────────────────────────────────────────────────

interface GeminiSeries { slug: string; name: string; year_start?: number; year_end?: number; popular: boolean }
interface GeminiModel  { slug: string; name: string; popular: boolean; series?: GeminiSeries[] }
interface GeminiMake   { slug: string; name: string; popular: boolean; models: GeminiModel[] }
interface GeminiOutput { makes: GeminiMake[] }

interface MergedSeries {
  slug:      string
  name:      string
  yearStart: number
  yearEnd:   number
  popular:   boolean
}
interface MergedModel {
  slug:      string
  name:      string
  yearStart: number
  yearEnd:   number
  popular:   boolean
  series:    Map<string, MergedSeries>
}
interface MergedMake {
  slug:    string
  name:    string
  popular: boolean
  models:  Map<string, MergedModel>
}

// ── Gemini ──────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  generationConfig: {
    responseMimeType: 'application/json',
  },
})

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

function promptForYear(year: number): string {
  return `List every passenger vehicle make sold new in Australia in ${year}, with their models available that year. Include commonly personally-imported vehicles that show up in Australian workshops (Mustang, Camaro, MG B, Alfa Giulia, Skyline R32/R34, Datsun 240Z etc.) as their real make.

Return a JSON array. Each element is an object with these fields — ALL required (slug, name, popular, models):
  - "slug"    : string  — lowercase ASCII, hyphenated, no punctuation. Examples: "toyota", "mercedes-benz", "3-series", "s-cross", "mg-b", "hilux".
  - "name"    : string  — human-readable make name. "Toyota", "Mercedes-Benz", "MG", "Ford".
  - "popular" : boolean
  - "models"  : array of model objects (see below).

Each model object has these required fields (slug, name, popular) plus an OPTIONAL "series" array:
  - "slug"    : string  — same slug rules.
  - "name"    : string  — base nameplate only. "Falcon" not "Falcon XR8". "Corolla" not "Corolla ZR".
  - "popular" : boolean — TRUE for top 3-5 models of that make in ${year}.
  - "series"  : (OPTIONAL) array of series objects.

Include a "series" array on a model only when the model has meaningful series/generation distinctions that a mechanic would recognise. Examples where "series" IS required:
  - Ford Falcon (AU): XA, XB, XC, XD, XE, XF, EA, EB, ED, EF, EL, AU, BA, BF, FG
  - Holden Commodore: VB, VC, VH, VK, VL, VN, VP, VR, VS, VT, VX, VY, VZ, VE, VF
  - Holden Kingswood: HK, HT, HG, HQ, HJ, HX, HZ, WB
  - Nissan Skyline / GT-R: R31, R32, R33, R34, R35
  - Toyota LandCruiser: 40-series, 60-series, 70-series, 80-series, 100-series, 200-series, 300-series
  - BMW 3 Series: E30, E36, E46, E90, F30, G20
  - Volkswagen Golf: Mk1, Mk2, Mk3, Mk4, Mk5, Mk6, Mk7, Mk8
  - Chrysler Valiant: AP5, AP6, VC, VE, VF, VG, VH, VJ, VK, CL, CM

Only include the series that were CURRENT in ${year} (i.e. year_start ≤ ${year} ≤ year_end).

Each series object has these fields (all required):
  - "slug"       : string  — lowercase, e.g. "xa", "xb", "r32", "e46", "80-series".
  - "name"       : string  — as spoken, e.g. "XA", "XB", "R32", "E46", "80 Series".
  - "year_start" : integer — first calendar year sold new.
  - "year_end"   : integer — last calendar year sold new (or ${year} if still current).
  - "popular"    : boolean — TRUE if this specific series is a notably popular workshop / collector target.

Omit the "series" field entirely on models with no meaningful series distinctions (Toyota Corolla, Ford Ranger, Kia Cerato).

Return ONLY the JSON array — no markdown, no explanatory text.

Content rules:
- popular on makes: TRUE only for the top 8 makes by new-car market share in ${year}.
- Do not invent trims or submodels as their own row.
- Do not include commercial trucks over 4.5 tonnes, buses, or motorcycles.
- Include ute / 4WD variants sold as separate model lines (e.g. HiLux, Ranger, LandCruiser 70/79/300).
- For 1960s-1970s: focus on cars that were genuinely sold new here (Holden, Ford Falcon, Chrysler Valiant, Datsun, Toyota, VW) plus popular restoration imports (Mustang, MG, Triumph, Datsun 240Z).`
}

async function fetchYear(year: number): Promise<{ year: number; makes: GeminiMake[] }> {
  const res = await model.generateContent(promptForYear(year))
  const text = stripFences(res.response.text())
  if (process.env.DEBUG_GEMINI) {
    console.error(`--- ${year} raw response (first 600 chars) ---`)
    console.error(text.slice(0, 600))
    console.error('---')
  }
  try {
    const parsed = JSON.parse(text) as GeminiOutput | GeminiMake[]
    // Gemini sometimes returns a bare array, sometimes the wrapped object.
    // Accept either.
    const makes = Array.isArray(parsed) ? parsed : (parsed.makes ?? [])
    return { year, makes }
  } catch (err) {
    console.error(`Failed to parse Gemini output for ${year}:`, text.slice(0, 300))
    throw err
  }
}

// Small semaphore so we run CONCURRENCY calls in parallel without blowing rate limits.
async function fetchAllYears(): Promise<Array<{ year: number; makes: GeminiMake[] }>> {
  const results: Array<{ year: number; makes: GeminiMake[] }> = []
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++
        if (idx >= years.length) return
        const y = years[idx]
        try {
          const r = await fetchYear(y)
          console.log(`  ${y}: ${r.makes.length} makes, ${r.makes.reduce((n, m) => n + m.models.length, 0)} models`)
          results.push(r)
        } catch (err) {
          console.error(`  ${y}: FAILED —`, (err as Error).message)
        }
      }
    })())
  }
  await Promise.all(workers)
  return results.sort((a, b) => a.year - b.year)
}

// ── Merge across years ──────────────────────────────────────────────────

function slugify(raw: string | undefined | null): string {
  if (!raw) return ''
  return String(raw).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Fallback used when Gemini returns a slug but no name. Title-cases each
// hyphen-separated word, keeps hyphens as spaces. "alfa-romeo" → "Alfa Romeo".
function titleFromSlug(slug: string): string {
  return slug.split('-')
    .map(w => w.length ? w[0].toUpperCase() + w.slice(1) : w)
    .join(' ')
}

function merge(years: Array<{ year: number; makes: GeminiMake[] }>): Map<string, MergedMake> {
  const makes = new Map<string, MergedMake>()

  for (const { year, makes: rawMakes } of years) {
    for (const m of rawMakes) {
      const makeSlug = slugify(m.slug || m.name)
      if (!makeSlug) continue

      let make = makes.get(makeSlug)
      if (!make) {
        const name = m.name?.trim() || titleFromSlug(makeSlug)
        make = { slug: makeSlug, name, popular: false, models: new Map() }
        makes.set(makeSlug, make)
      }
      // Popular flag: OR across years, but forced false if we never see this
      // make above the classic cutoff — decided later, once all years merged.
      if (year >= POPULAR_CUTOFF && m.popular) make.popular = true

      for (const md of m.models) {
        const modelSlug = slugify(md.slug || md.name)
        if (!modelSlug) continue
        let mm = make.models.get(modelSlug)
        if (!mm) {
          const mName = md.name?.trim() || titleFromSlug(modelSlug)
          mm = { slug: modelSlug, name: mName, yearStart: year, yearEnd: year, popular: false, series: new Map() }
          make.models.set(modelSlug, mm)
        } else {
          if (year < mm.yearStart) mm.yearStart = year
          if (year > mm.yearEnd)   mm.yearEnd   = year
        }
        if (year >= POPULAR_CUTOFF && md.popular) mm.popular = true

        // Series — only present for models with meaningful generations.
        for (const s of (md.series ?? [])) {
          const seriesSlug = slugify(s.slug || s.name)
          if (!seriesSlug) continue
          // Trust Gemini's year_start/year_end for the series definition, falling
          // back to the current year if omitted.
          const yStart = Number.isInteger(s.year_start) ? Number(s.year_start) : year
          const yEnd   = Number.isInteger(s.year_end)   ? Number(s.year_end)   : year
          let ss = mm.series.get(seriesSlug)
          if (!ss) {
            const sName = s.name?.trim() || titleFromSlug(seriesSlug)
            ss = { slug: seriesSlug, name: sName, yearStart: yStart, yearEnd: yEnd, popular: false }
            mm.series.set(seriesSlug, ss)
          } else {
            if (yStart < ss.yearStart) ss.yearStart = yStart
            if (yEnd   > ss.yearEnd)   ss.yearEnd   = yEnd
          }
          if (s.popular) ss.popular = true
        }
      }
    }
  }

  return makes
}

// ── DB upsert (additive-only) ───────────────────────────────────────────

async function upsert(db: mysql.Pool, makes: Map<string, MergedMake>) {
  let makesInserted = 0, makesExisting = 0
  let modelsInserted = 0, modelsExtended = 0, modelsExisting = 0
  let seriesInserted = 0, seriesExtended = 0, seriesExisting = 0

  for (const make of Array.from(makes.values())) {
    // Insert if new; if exists, return existing id without overwriting.
    const [res] = await db.query<any>(
      `INSERT INTO vehicle_makes (slug, name, popular)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
      [make.slug, make.name, make.popular ? 1 : 0],
    )
    // insertId is 0 when ON DUPLICATE KEY hit; look it up.
    let makeId = (res as any).insertId as number
    if (!makeId) {
      const [[row]] = await db.query<any[]>(
        'SELECT id FROM vehicle_makes WHERE slug = ? LIMIT 1',
        [make.slug],
      )
      makeId = row?.id
      makesExisting++
    } else {
      makesInserted++
    }
    if (!makeId) throw new Error(`Failed to obtain id for make ${make.slug}`)

    for (const mm of Array.from(make.models.values())) {
      // Additive semantics:
      //   - INSERT if not exists
      //   - If exists: extend year range (shrink year_start, grow year_end),
      //     but never touch name / popular (staff may have hand-fixed those).
      const [mRes] = await db.query<any>(
        `INSERT INTO vehicle_models (make_id, slug, name, year_start, year_end, popular)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             year_start = LEAST(year_start, VALUES(year_start)),
             year_end   = GREATEST(year_end, VALUES(year_end))`,
        [makeId, mm.slug, mm.name, mm.yearStart, mm.yearEnd, mm.popular ? 1 : 0],
      )
      let modelId = (mRes as any).insertId as number
      const affected = (mRes as any).affectedRows as number
      if (affected === 1) modelsInserted++
      else if (affected === 2) modelsExtended++
      else modelsExisting++
      if (!modelId) {
        const [[row]] = await db.query<any[]>(
          'SELECT id FROM vehicle_models WHERE make_id = ? AND slug = ? LIMIT 1',
          [makeId, mm.slug],
        )
        modelId = row?.id
      }
      if (!modelId) throw new Error(`Failed to obtain id for model ${make.slug}/${mm.slug}`)

      for (const ss of Array.from(mm.series.values())) {
        const [sRes] = await db.query<any>(
          `INSERT INTO vehicle_model_series (model_id, slug, name, year_start, year_end, popular)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               year_start = LEAST(year_start, VALUES(year_start)),
               year_end   = GREATEST(year_end, VALUES(year_end))`,
          [modelId, ss.slug, ss.name, ss.yearStart, ss.yearEnd, ss.popular ? 1 : 0],
        )
        const sa = (sRes as any).affectedRows as number
        if (sa === 1) seriesInserted++
        else if (sa === 2) seriesExtended++
        else seriesExisting++
      }
    }
  }

  console.log('')
  console.log('Upsert summary:')
  console.log(`  Makes  — inserted ${makesInserted},  already existed ${makesExisting}`)
  console.log(`  Models — inserted ${modelsInserted}, year-range extended ${modelsExtended}, unchanged ${modelsExisting}`)
  console.log(`  Series — inserted ${seriesInserted}, year-range extended ${seriesExtended}, unchanged ${seriesExisting}`)
}

// ── Mismatch report against real customer vehicles ──────────────────────

async function mismatchReport(db: mysql.Pool, makes: Map<string, MergedMake>): Promise<void> {
  const [rows] = await db.query<any[]>(
    `SELECT DISTINCT LOWER(TRIM(make)) AS make_raw, LOWER(TRIM(model)) AS model_raw, year, COUNT(*) AS vehicle_count
     FROM vehicles
     WHERE is_active = 1 AND make IS NOT NULL AND model IS NOT NULL AND year IS NOT NULL
     GROUP BY make_raw, model_raw, year
     ORDER BY vehicle_count DESC, make_raw, model_raw`,
  )

  const mismatches: Array<{ make: string; model: string; year: number; count: number }> = []

  for (const r of rows) {
    const makeSlug = slugify(r.make_raw)
    const modelSlug = slugify(r.model_raw)
    const make = makes.get(makeSlug)
    if (!make) {
      mismatches.push({ make: r.make_raw, model: r.model_raw, year: r.year, count: r.vehicle_count })
      continue
    }
    const mm = make.models.get(modelSlug)
    if (!mm) {
      mismatches.push({ make: r.make_raw, model: r.model_raw, year: r.year, count: r.vehicle_count })
      continue
    }
    if (r.year < mm.yearStart || r.year > mm.yearEnd) {
      mismatches.push({ make: r.make_raw, model: r.model_raw, year: r.year, count: r.vehicle_count })
    }
  }

  console.log('')
  console.log(`Mismatch report: ${mismatches.length} distinct (make, model, year) tuples in vehicles table have no catalog match.`)
  if (mismatches.length === 0) return

  console.log('  (staff should hand-fix these via the admin UI once step 3 ships)')
  console.log('')
  console.log('  count  year  make                  model')
  console.log('  -----  ----  --------------------  --------------------')
  for (const m of mismatches.slice(0, 50)) {
    console.log(`  ${String(m.count).padStart(5)}  ${m.year}  ${m.make.padEnd(20)}  ${m.model}`)
  }
  if (mismatches.length > 50) console.log(`  ... and ${mismatches.length - 50} more`)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is required.'); process.exit(1)
  }
  console.log(`Seeding catalog for years ${years[0]}–${years[years.length - 1]} (${years.length} total). Dry-run: ${dryRun}`)
  console.log('')

  console.log('Fetching from Gemini…')
  const perYear = await fetchAllYears()
  console.log('')

  console.log('Merging across years…')
  const makes = merge(perYear)
  const totalModels = Array.from(makes.values()).reduce((n, m) => n + m.models.size, 0)
  const totalSeries = Array.from(makes.values())
    .flatMap(m => Array.from(m.models.values()))
    .reduce((n, mm) => n + mm.series.size, 0)
  console.log(`  ${makes.size} unique makes, ${totalModels} unique models, ${totalSeries} unique series.`)

  if (dryRun) {
    console.log('')
    console.log('Merged output:')
    for (const make of Array.from(makes.values())) {
      console.log(`  ${make.name} (${make.slug})${make.popular ? '  ★popular' : ''}`)
      for (const mm of Array.from(make.models.values())) {
        console.log(`    ${mm.name} (${mm.slug})  ${mm.yearStart}–${mm.yearEnd}${mm.popular ? '  ★popular' : ''}`)
        for (const ss of Array.from(mm.series.values())) {
          console.log(`      ${ss.name} (${ss.slug})  ${ss.yearStart}–${ss.yearEnd}${ss.popular ? '  ★popular' : ''}`)
        }
      }
    }
    console.log('')
    console.log('DRY RUN — not writing to DB.')
    return
  }

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  const db = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     Number(process.env.DB_PORT ?? 3306),
    ssl:      { rejectUnauthorized },
    connectionLimit: 5,
  })

  try {
    console.log('')
    console.log('Upserting into DB (additive-only)…')
    await upsert(db, makes)
    await mismatchReport(db, makes)
  } finally {
    await db.end()
  }

  console.log('')
  console.log('Done.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
