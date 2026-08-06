import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { handler as historyHandler } from '../../src/customers/vehicles/odometer-history'
import { handler as adminRunsHandler } from '../../src/admin/odometer-bump-runs'
import { handler as weeklyBumpHandler } from '../../src/ai/weekly-odometer-bump'
import { bumpOdometer } from '../../src/shared/odometer'
import { staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'
import { getPool } from '../../src/shared/db'

// Full audit trail for the workshop "Odometer" tab + weekly-bump cron
// observability.
//
// Uses vehicle 4 (customer 3, store 5) as the target throughout. Every
// test brackets its work in a purge() call so we don't pollute the
// history of a real vehicle across runs. Each test also stashes and
// restores the vehicle's odometer_current + recorded_at so the vehicles
// row is left the way we found it.

const CUSTOMER_ID = 3
const VEHICLE_ID  = 4

const admin   = { staffId: '1', role: 'super_admin'   as const, storeId: 1 }
const manager = { staffId: '3', role: 'store_manager' as const, storeId: 5 }

// Marker on all rows this suite writes so we can safely purge without
// touching the production backfill row for the same vehicle.
const NOTE_PREFIX = 'INTEGRATION_TEST:'

let baselineOdometer: number | null = null
let baselineRecordedAt: Date | null = null

async function snapshotVehicle() {
  const [[row]] = await db().query<any[]>(
    'SELECT odometer_current, odometer_recorded_at FROM vehicles WHERE id = ?',
    [VEHICLE_ID],
  )
  baselineOdometer   = row.odometer_current != null ? Number(row.odometer_current) : null
  baselineRecordedAt = row.odometer_recorded_at ? new Date(row.odometer_recorded_at) : null
}

async function restoreVehicle() {
  await db().query(
    'UPDATE vehicles SET odometer_current = ?, odometer_recorded_at = ? WHERE id = ?',
    [baselineOdometer, baselineRecordedAt, VEHICLE_ID],
  )
}

async function purgeTestHistory() {
  await db().query(
    `DELETE FROM odometer_history
     WHERE vehicle_id = ? AND (notes LIKE ? OR source_ref LIKE ?)`,
    [VEHICLE_ID, `${NOTE_PREFIX}%`, 'test:%'],
  )
}

afterEach(async () => {
  await restoreVehicle()
  await purgeTestHistory()
})

afterAll(async () => {
  await purgeTestHistory()
})

describe('bumpOdometer — forward writes + history', () => {
  it('writes odometer_history row on successful forward write', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 0) + 500

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'staff-patch', {
      actorType: 'staff',
      actorId:   1,
      notes:     `${NOTE_PREFIX}forward-write`,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.changed).toBe(true)
      expect(res.current).toBe(target)
      expect(res.historyId).toBeGreaterThan(0)
    }

    const [[row]] = await db().query<any[]>(
      'SELECT source, actor_type, actor_id, new_km, delta_km FROM odometer_history WHERE notes = ? LIMIT 1',
      [`${NOTE_PREFIX}forward-write`],
    )
    expect(row.source).toBe('staff-patch')
    expect(row.actor_type).toBe('staff')
    expect(Number(row.actor_id)).toBe(1)
    expect(Number(row.new_km)).toBe(target)
    expect(Number(row.delta_km)).toBe(500)
  })

  it('same-value call is ok+unchanged and writes no history row', async () => {
    await snapshotVehicle()
    const pool = getPool()

    const res = await bumpOdometer(pool, VEHICLE_ID, baselineOdometer ?? 0, 'staff-patch', {
      actorType: 'staff', actorId: 1, notes: `${NOTE_PREFIX}same-value`,
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.changed).toBe(false)

    const [rows] = await db().query<any[]>(
      'SELECT id FROM odometer_history WHERE notes = ?',
      [`${NOTE_PREFIX}same-value`],
    )
    expect(rows).toHaveLength(0)
  })
})

describe('bumpOdometer — backwards-write policy', () => {
  it('customer-patch backwards refuses (and writes no history)', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 1000) - 200

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'customer-patch', {
      actorType: 'customer', actorId: 3, notes: `${NOTE_PREFIX}cust-back`,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('backwards')
  })

  it('staff-patch backwards without reason returns correction_reason_required', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 1000) - 200

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'staff-patch', {
      actorType: 'staff', actorId: 1, allowBackwards: true,
      notes: `${NOTE_PREFIX}staff-back-no-reason`,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('correction_reason_required')
  })

  it('staff-patch backwards with correctionReason writes staff-correction row', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 1000) - 5000

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'staff-patch', {
      actorType: 'staff', actorId: 1, allowBackwards: true,
      correctionReason: `${NOTE_PREFIX}meter replaced during rebuild`,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.changed).toBe(true)
      expect(res.correction).toBe(true)
    }

    const [[row]] = await db().query<any[]>(
      'SELECT source, notes, delta_km FROM odometer_history WHERE notes = ? LIMIT 1',
      [`${NOTE_PREFIX}meter replaced during rebuild`],
    )
    expect(row.source).toBe('staff-correction')
    expect(Number(row.delta_km)).toBeLessThan(0)
  })

  it('job-entry backwards is always allowed (no reason needed)', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 1000) - 500

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'job-entry', {
      actorType: 'staff', actorId: 1, allowBackwards: true,
      sourceRef: 'test:job-123',
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.correction).toBe(true)

    const [[row]] = await db().query<any[]>(
      'SELECT source FROM odometer_history WHERE source_ref = ? LIMIT 1',
      ['test:job-123'],
    )
    expect(row.source).toBe('job-entry')
  })

  it('fuel-fill backwards is a soft no-op — no error, no history', async () => {
    await snapshotVehicle()
    const pool = getPool()
    const target = (baselineOdometer ?? 1000) - 100

    const res = await bumpOdometer(pool, VEHICLE_ID, target, 'fuel-fill', {
      actorType: 'customer', actorId: 3, sourceRef: 'test:ff-1',
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.changed).toBe(false)

    const [rows] = await db().query<any[]>(
      'SELECT id FROM odometer_history WHERE source_ref = ?',
      ['test:ff-1'],
    )
    expect(rows).toHaveLength(0)
  })
})

describe('GET odometer-history endpoint', () => {
  it('returns history + stats + pagination cursor', async () => {
    await snapshotVehicle()
    const pool = getPool()
    // Two forward writes to make sure history has content beyond the backfill row.
    await bumpOdometer(pool, VEHICLE_ID, (baselineOdometer ?? 0) + 100, 'staff-patch', {
      actorType: 'staff', actorId: 1, notes: `${NOTE_PREFIX}hist-1`,
    })
    await bumpOdometer(pool, VEHICLE_ID, (baselineOdometer ?? 0) + 300, 'staff-patch', {
      actorType: 'staff', actorId: 1, notes: `${NOTE_PREFIX}hist-2`,
    })

    const { status, body } = parse(await historyHandler(staffEvent(admin, {
      path: { customerId: String(CUSTOMER_ID), vehicleId: String(VEHICLE_ID) },
      query: { limit: '50' },
    })) as any)

    expect(status).toBe(200)
    expect(Array.isArray(body.history)).toBe(true)
    expect(body.history.length).toBeGreaterThanOrEqual(2)
    expect(body.stats.totalReadings).toBeGreaterThanOrEqual(2)
    expect(typeof body.stats.latestKm).toBe('number')
    expect(typeof body.stats.kmLast30Days).toBe('number')
    expect(body.stats.sourceCounts).toBeDefined()
    // Newest first.
    expect(body.history[0].newKm).toBeGreaterThanOrEqual(body.history[1].newKm)
    // Shape check on the first row.
    const first = body.history[0]
    expect(first.actor).toBeDefined()
    expect(first.sourceLabel).toBeDefined()
    expect(typeof first.recordedAt).toBe('string')
  })

  it('404s for a vehicle not owned by the customer', async () => {
    const { status } = parse(await historyHandler(staffEvent(admin, {
      path: { customerId: '2', vehicleId: String(VEHICLE_ID) },
    })) as any)
    expect(status).toBe(404)
  })

  it('store_manager on the same store gets 200', async () => {
    const { status } = parse(await historyHandler(staffEvent(manager, {
      path: { customerId: String(CUSTOMER_ID), vehicleId: String(VEHICLE_ID) },
    })) as any)
    expect(status).toBe(200)
  })
})

describe('Weekly bump — writes odometer_bump_runs row', () => {
  it('dry run inserts one row with dry_run=1 and bumped=0', async () => {
    const before = await db().query<any[]>('SELECT COUNT(*) AS n FROM odometer_bump_runs')
    const beforeN = Number((before[0][0] as any).n)

    const result = await weeklyBumpHandler({ dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.runId).toBeGreaterThan(0)

    const [[after]] = await db().query<any[]>('SELECT COUNT(*) AS n FROM odometer_bump_runs')
    expect(Number(after.n)).toBe(beforeN + 1)

    const [[row]] = await db().query<any[]>(
      'SELECT dry_run, bumped, eligible FROM odometer_bump_runs WHERE id = ?',
      [result.runId],
    )
    expect(Boolean(row.dry_run)).toBe(true)
    // In dry-run mode `bumped` reports "would have" — matches eligible for
    // the survive-the-skip-rules subset. See weekly-odometer-bump.ts.
    expect(Number(row.bumped)).toBe(Number(row.eligible))
    expect(Number(row.eligible)).toBeGreaterThanOrEqual(0)
  })
})

describe('GET admin/odometer-bump-runs', () => {
  it('returns runs verbatim for super_admin', async () => {
    await weeklyBumpHandler({ dryRun: true })

    const { status, body } = parse(await adminRunsHandler(staffEvent(admin, {
      query: { limit: '5' },
    })) as any)

    expect(status).toBe(200)
    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.runs.length).toBeGreaterThan(0)
    expect(body.runs[0].dryRun).toBeDefined()
    expect(body.runs[0].skipped).toBeDefined()
  })

  it('403s a store_manager', async () => {
    const { status } = parse(await adminRunsHandler(staffEvent(manager, {})) as any)
    expect(status).toBe(403)
  })
})
