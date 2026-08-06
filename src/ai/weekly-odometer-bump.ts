import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { maybeRegenerateSchedule } from '../shared/aiEngines'
import { bumpOdometer } from '../shared/odometer'

const ready = bootstrap()

// Fallback when a customer hasn't declared their own weekly average.
// Matches ABS 2024 AU average (~12,500 km/year).
const DEFAULT_KM_PER_WEEK = 240

// Skip vehicles whose last real odometer reading is older than this.
// If a customer hasn't recorded a real reading in a year, the vehicle
// has probably been sold / stored / forgotten — inflating the number
// weekly for another year would only produce misleading "service due"
// alerts on cars that aren't being driven.
const STALE_MONTHS = 12

export interface WeeklyBumpEvent {
  // Set to true for a "show me what would happen" run — reports the
  // eligible/skipped counts without touching any rows or firing any
  // schedule regens. Handy from `aws lambda invoke` for a sanity check.
  dryRun?: boolean
}

export interface WeeklyBumpResult {
  eligible: number
  bumped:   number
  skipped:  { inactive: number; no_reading: number; stale: number; no_owner: number }
  dryRun:   boolean
  runId:    number | null
}

// EventBridge cron → Lambda. Runs every Sunday 15:00 UTC (Monday 1am AEST).
//
// For every vehicle that survives the four skip rules, adds either the
// customer-declared avg_km_per_week or DEFAULT_KM_PER_WEEK to
// odometer_current via bumpOdometer(). Each bump writes one row to
// odometer_history with source='weekly-bump'. Also fires
// maybeRegenerateSchedule per vehicle — cheap no-op until the delta
// since the last regen crosses 10 km.
//
// Wraps in try/catch/finally so a single row lands in odometer_bump_runs
// on every invocation (success or failure) — makes "did the cron run
// this week?" a one-query answer instead of CloudWatch archaeology.
export const handler = async (event: WeeklyBumpEvent = {}): Promise<WeeklyBumpResult> => {
  await ready
  const db     = getPool()
  const dryRun = !!event.dryRun
  const startedAt = Date.now()

  let eligible = 0
  let bumped   = 0
  const skipped = { inactive: 0, no_reading: 0, stale: 0, no_owner: 0 }
  const failedVehicleIds: number[] = []
  let topLevelError: string | null = null

  try {
    // Skip counts — computed once at the top so we can report them even
    // in dry-run mode. Duplicates a bit of WHERE logic with the main
    // query below, but keeps the stats query and the hot-path query
    // independently readable.
    const [[skipRow]] = await db.query<any[]>(
      `SELECT
         SUM(CASE WHEN v.is_active = 0 THEN 1 ELSE 0 END) AS inactive,

         SUM(CASE WHEN v.is_active = 1
                   AND (v.odometer_current IS NULL OR v.odometer_recorded_at IS NULL)
                  THEN 1 ELSE 0 END) AS no_reading,

         SUM(CASE WHEN v.is_active = 1
                   AND v.odometer_recorded_at IS NOT NULL
                   AND v.odometer_recorded_at < (NOW() - INTERVAL ${STALE_MONTHS} MONTH)
                  THEN 1 ELSE 0 END) AS stale,

         SUM(CASE WHEN v.is_active = 1
                   AND v.odometer_current IS NOT NULL
                   AND v.odometer_recorded_at IS NOT NULL
                   AND v.odometer_recorded_at >= (NOW() - INTERVAL ${STALE_MONTHS} MONTH)
                   AND NOT EXISTS (
                     SELECT 1 FROM vehicle_owners vo
                      WHERE vo.vehicle_id = v.id AND vo.is_current = 1
                   )
                  THEN 1 ELSE 0 END) AS no_owner
       FROM vehicles v`,
    )
    skipped.inactive   = Number(skipRow?.inactive   ?? 0)
    skipped.no_reading = Number(skipRow?.no_reading ?? 0)
    skipped.stale      = Number(skipRow?.stale      ?? 0)
    skipped.no_owner   = Number(skipRow?.no_owner   ?? 0)

    // Eligible vehicles — all four skip rules passed.
    const [rows] = await db.query<any[]>(
      `SELECT v.id AS vehicle_id, v.odometer_current, v.avg_km_per_week, vo.customer_id
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.is_active = 1
         AND v.odometer_current IS NOT NULL
         AND v.odometer_recorded_at IS NOT NULL
         AND v.odometer_recorded_at >= (NOW() - INTERVAL ${STALE_MONTHS} MONTH)`,
    )
    eligible = rows.length

    console.log(`[weekly-odometer-bump] eligible=${eligible} skipped=${JSON.stringify(skipped)} dryRun=${dryRun}`)

    for (const row of rows) {
      const perWeek = row.avg_km_per_week != null ? Number(row.avg_km_per_week) : DEFAULT_KM_PER_WEEK
      if (!Number.isFinite(perWeek) || perWeek <= 0) continue

      const newKm = Number(row.odometer_current) + perWeek

      if (!dryRun) {
        try {
          const result = await bumpOdometer(db, Number(row.vehicle_id), newKm, 'weekly-bump', {
            actorType: 'system',
            actorId:   null,
          })
          if (!result.ok || !result.changed) continue
          // maybeRegenerateSchedule checks internally whether the delta
          // since the last regen has crossed 10 km — cheap no-op most
          // weeks, fires the AI generator when the vehicle has drifted
          // far enough to warrant a fresh schedule.
          await maybeRegenerateSchedule(
            db,
            Number(row.vehicle_id),
            newKm,
            Number(row.customer_id),
          )
        } catch (err) {
          console.error(`[weekly-odometer-bump] vehicle ${row.vehicle_id} failed:`, err)
          failedVehicleIds.push(Number(row.vehicle_id))
          continue
        }
      }
      bumped++
    }

    console.log(`[weekly-odometer-bump] bumped=${bumped} failed=${failedVehicleIds.length}`)
  } catch (err: any) {
    topLevelError = err?.message ?? String(err)
    console.error('[weekly-odometer-bump] top-level failure:', err)
  }

  // Always land one row — success or failure. Makes "did the cron run?"
  // a single SELECT, no CloudWatch log group hunting.
  let runId: number | null = null
  try {
    const [ins] = await db.query<any>(
      `INSERT INTO odometer_bump_runs
         (ran_at, duration_ms, dry_run, eligible, bumped,
          skipped_inactive, skipped_no_reading, skipped_stale, skipped_no_owner,
          failed_vehicle_ids, error)
       VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now() - startedAt,
        dryRun ? 1 : 0,
        eligible,
        bumped,
        skipped.inactive,
        skipped.no_reading,
        skipped.stale,
        skipped.no_owner,
        failedVehicleIds.length ? JSON.stringify(failedVehicleIds) : null,
        topLevelError,
      ],
    )
    runId = Number(ins.insertId)
  } catch (err) {
    console.error('[weekly-odometer-bump] failed to write runs row:', err)
  }

  return { eligible, bumped, skipped, dryRun, runId }
}
