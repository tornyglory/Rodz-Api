// Backfill vehicles.make_id / model_id / series_id from the freeform
// vehicles.make / model / series strings by matching against the
// vehicle_makes / vehicle_models / vehicle_model_series catalog.
//
// Idempotent — only fills NULL FKs. Re-runnable safely.
//
// Match strategy:
//   1. slugify(vehicles.make)  → vehicle_makes.slug
//   2. slugify(vehicles.model) → vehicle_models.slug (WITHIN the make)
//   3. Check vehicles.year is within [year_start, year_end]
//   4. slugify(vehicles.series) → vehicle_model_series.slug (WITHIN the model)
//      Skipped if series string is null/empty.
//
// Usage:
//   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=rodz \
//   npx tsx scripts/backfill-vehicle-catalog-fks.ts [--dry-run]

import 'dotenv/config'
import * as mysql from 'mysql2/promise'

const dryRun = process.argv.includes('--dry-run')

function slugify(raw: string | null | undefined): string {
  if (!raw) return ''
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

interface Vehicle {
  id: number; make: string; model: string; series: string | null; year: number
  make_id: number | null; model_id: number | null; series_id: number | null
}

interface Result {
  total:          number
  updated:        number
  alreadyLinked:  number
  noMakeMatch:    string[]
  noModelMatch:   string[]
  yearMismatch:   string[]
  noSeriesMatch:  string[]
}

async function main() {
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

  console.log(`Vehicle catalog FK backfill — ${dryRun ? 'DRY RUN' : 'LIVE'}\n`)

  try {
    const [vehicles] = await db.query<any[]>(
      `SELECT id, make, model, series, year, make_id, model_id, series_id
       FROM vehicles
       WHERE is_active = 1
         AND (make_id IS NULL OR model_id IS NULL OR (series IS NOT NULL AND series != '' AND series_id IS NULL))`,
    )

    const result: Result = {
      total: vehicles.length,
      updated: 0,
      alreadyLinked: 0,
      noMakeMatch:  [],
      noModelMatch: [],
      yearMismatch: [],
      noSeriesMatch: [],
    }

    for (const v of vehicles as Vehicle[]) {
      const makeSlug  = slugify(v.make)
      const modelSlug = slugify(v.model)
      const seriesSlug = slugify(v.series)

      if (!makeSlug) { result.noMakeMatch.push(`${v.id}: make="${v.make}"`); continue }

      const [[makeRow]] = await db.query<any[]>('SELECT id FROM vehicle_makes WHERE slug = ? LIMIT 1', [makeSlug])
      if (!makeRow) { result.noMakeMatch.push(`${v.id}: make="${v.make}" (${makeSlug})`); continue }

      const [[modelRow]] = await db.query<any[]>(
        'SELECT id, year_start, year_end FROM vehicle_models WHERE make_id = ? AND slug = ? LIMIT 1',
        [makeRow.id, modelSlug],
      )
      if (!modelRow) { result.noModelMatch.push(`${v.id}: ${v.make}/${v.model} (${makeSlug}/${modelSlug})`); continue }

      const yearOK = v.year >= modelRow.year_start && v.year <= modelRow.year_end
      if (!yearOK) {
        result.yearMismatch.push(`${v.id}: ${v.make} ${v.model} ${v.year} outside model range ${modelRow.year_start}-${modelRow.year_end}`)
        // Still link it — the freeform data is our source of truth for
        // now, and staff will notice via the mismatch report. Widen
        // via the admin UI if legit.
      }

      let seriesId: number | null = null
      if (seriesSlug) {
        const [[seriesRow]] = await db.query<any[]>(
          'SELECT id, year_start, year_end FROM vehicle_model_series WHERE model_id = ? AND slug = ? LIMIT 1',
          [modelRow.id, seriesSlug],
        )
        if (seriesRow) {
          seriesId = seriesRow.id
        } else {
          result.noSeriesMatch.push(`${v.id}: ${v.make} ${v.model} series="${v.series}" (${seriesSlug})`)
        }
      }

      // Only update the columns that need it.
      const sets: string[] = []
      const params: unknown[] = []
      if (v.make_id === null)  { sets.push('make_id = ?');  params.push(makeRow.id) }
      if (v.model_id === null) { sets.push('model_id = ?'); params.push(modelRow.id) }
      if (v.series_id === null && seriesId !== null) { sets.push('series_id = ?'); params.push(seriesId) }

      if (sets.length === 0) {
        result.alreadyLinked++
        continue
      }

      if (!dryRun) {
        await db.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`, [...params, v.id])
      }
      result.updated++
    }

    console.log('Backfill summary:')
    console.log(`  Vehicles considered: ${result.total}`)
    console.log(`  Updated:             ${result.updated}${dryRun ? ' (dry-run — no writes)' : ''}`)
    console.log(`  Already linked:      ${result.alreadyLinked}`)
    console.log('')
    if (result.noMakeMatch.length) {
      console.log(`No make match (${result.noMakeMatch.length}):`)
      for (const m of result.noMakeMatch) console.log(`  ${m}`)
    }
    if (result.noModelMatch.length) {
      console.log(`No model match (${result.noModelMatch.length}):`)
      for (const m of result.noModelMatch) console.log(`  ${m}`)
    }
    if (result.yearMismatch.length) {
      console.log(`Year outside catalog range but linked anyway (${result.yearMismatch.length}):`)
      for (const m of result.yearMismatch) console.log(`  ${m}`)
    }
    if (result.noSeriesMatch.length) {
      console.log(`No series match (${result.noSeriesMatch.length}) — make/model still linked:`)
      for (const m of result.noSeriesMatch) console.log(`  ${m}`)
    }
  } finally {
    await db.end()
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
