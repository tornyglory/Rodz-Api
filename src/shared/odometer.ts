import type mysql from 'mysql2/promise'

// One source of truth for vehicle mileage: `vehicles.odometer_current`.
// Every writer routes through this helper so the value can never decrease
// once set — except from authoritative sources (workshop job entries,
// staff-issued corrections with a stated reason). Every successful change
// also writes one row to `odometer_history` for the workshop "Odometer"
// tab audit trail.

export type OdometerSource =
  | 'staff-patch'        // staff-side vehicle PATCH (no downward writes without a reason)
  | 'staff-correction'   // staff-side downward correction with a stated reason
  | 'customer-patch'     // customer-side vehicle PATCH (no downward writes)
  | 'job-entry'          // workshop job entry (odometer_in) — authoritative
  | 'fuel-fill'          // customer fuel-fill snapshot
  | 'expense'            // customer expense snapshot
  | 'logbook-entry'      // customer logbook entry (past service)
  | 'weekly-bump'        // EventBridge weekly-odometer-bump cron
  | 'booking-create'     // guest / customer booking creation snapshot
  | 'transfer'           // vehicle ownership transfer (odometer_at_release)
  | 'ai-agent'           // customer chat / voice booking assistant
  | 'backfill'           // migration-time initial rows (not written at runtime)

export type ActorType = 'staff' | 'customer' | 'system' | 'ai-agent'

// Sources that are considered authoritative enough to lower the odometer.
// job-entry: the tech is looking at the dashboard, that's ground truth.
// staff-correction: staff has stated a reason (meter replaced, initial
// error, garaged drift). Any other downward attempt is either refused
// (customer / ai-agent) or a soft no-op (fuel-fill / expense / logbook).
const HARD_WRITE_SOURCES: readonly OdometerSource[] = ['staff-patch', 'staff-correction', 'customer-patch', 'job-entry', 'ai-agent']
const SOFT_WRITE_SOURCES: readonly OdometerSource[] = ['fuel-fill', 'expense', 'logbook-entry', 'booking-create', 'transfer']

export interface BumpOdometerOptions {
  actorType:         ActorType
  actorId?:          number | null
  sourceRef?:        string | null
  notes?:            string | null
  // Set true to permit downward writes. Only respected for job-entry and
  // staff-patch (staff-patch gets rewritten to staff-correction when a
  // backwards write actually lands). Everyone else is ignored.
  allowBackwards?:   boolean
  // Required when a staff-patch is going backwards. Stored on the history
  // row so future readers can see WHY the odometer went down.
  correctionReason?: string | null
}

export type BumpResult =
  | { ok: true;  previous: number | null; current: number; changed: boolean; historyId: number | null; correction?: boolean }
  | { ok: false; reason: 'backwards'; previous: number; attempted: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'correction_reason_required'; previous: number; attempted: number }

/**
 * Set the vehicle's `odometer_current` to `newKm` and log the change.
 *
 * Backwards-write policy:
 *   • job-entry — always allowed (workshop physically reads the dash)
 *   • staff-patch — allowed only when `correctionReason` is supplied;
 *     recorded as `staff-correction` in the history log
 *   • customer-patch / ai-agent — refused (returns backwards result)
 *   • fuel-fill / expense / logbook-entry / booking-create / transfer —
 *     backwards is a soft no-op (returns changed: false, ok: true)
 *   • weekly-bump — never sends a lower value (loop math only ever adds)
 *
 * Every successful change writes one row to `odometer_history`. Same-value
 * calls return `ok: true, changed: false` and log nothing.
 */
export async function bumpOdometer(
  db: mysql.Pool,
  vehicleId: number,
  newKm: number,
  source: OdometerSource,
  opts: BumpOdometerOptions,
): Promise<BumpResult> {
  if (!Number.isFinite(newKm) || newKm < 0) {
    return { ok: false, reason: 'backwards', previous: 0, attempted: newKm }
  }
  const km = Math.floor(newKm)

  const [[row]] = await db.query<any[]>(
    'SELECT odometer_current, odometer_recorded_at FROM vehicles WHERE id = ? LIMIT 1',
    [vehicleId],
  )
  if (!row) return { ok: false, reason: 'not_found' }

  const previous: number | null = row.odometer_current != null ? Number(row.odometer_current) : null

  // First-ever reading — always allowed, straight write.
  if (previous == null) {
    await db.query(
      'UPDATE vehicles SET odometer_current = ?, odometer_recorded_at = NOW(), updated_at = NOW() WHERE id = ?',
      [km, vehicleId],
    )
    const historyId = await writeHistory(db, vehicleId, null, km, source, opts)
    return { ok: true, previous: null, current: km, changed: true, historyId }
  }

  if (km === previous) {
    return { ok: true, previous, current: km, changed: false, historyId: null }
  }

  // Downward write path — policy depends on source.
  if (km < previous) {
    const isJobEntry     = source === 'job-entry'
    const isStaffPatch   = source === 'staff-patch'
    const isSoftSource   = SOFT_WRITE_SOURCES.includes(source)

    // Soft sources: fuel-fill / expense / logbook / booking / transfer.
    // These are snapshots that may be older than the current reading —
    // never a hard error, just a silent no-op.
    if (isSoftSource) {
      return { ok: true, previous, current: previous, changed: false, historyId: null }
    }

    // Job entry: workshop reads the dashboard — always authoritative.
    if (isJobEntry) {
      await applyWrite(db, vehicleId, km)
      const historyId = await writeHistory(db, vehicleId, previous, km, 'job-entry', opts)
      return { ok: true, previous, current: km, changed: true, historyId, correction: true }
    }

    // Staff patch going backwards — needs a reason. Reason is stored on
    // the history row and the source gets rewritten to staff-correction
    // so the workshop tab can render it distinctly.
    if (isStaffPatch && opts.allowBackwards) {
      const reason = (opts.correctionReason ?? '').trim()
      if (!reason) {
        return { ok: false, reason: 'correction_reason_required', previous, attempted: km }
      }
      await applyWrite(db, vehicleId, km)
      const historyId = await writeHistory(db, vehicleId, previous, km, 'staff-correction', {
        ...opts,
        notes: reason,
      })
      return { ok: true, previous, current: km, changed: true, historyId, correction: true }
    }

    // Everyone else (customer-patch, ai-agent, staff-patch without allow):
    // refuse. Caller decides whether that's a 422 or a soft ignore.
    return { ok: false, reason: 'backwards', previous, attempted: km }
  }

  // Forward write — the normal case. Also covers the first non-null
  // update path (weekly-bump, job-entry, staff-patch, customer-patch, …).
  if (!HARD_WRITE_SOURCES.includes(source) && !SOFT_WRITE_SOURCES.includes(source) && source !== 'weekly-bump') {
    // Only 'backfill' should end up here — never at runtime. Keep it
    // strict so a new OdometerSource value can't silently slip through.
    return { ok: false, reason: 'backwards', previous, attempted: km }
  }

  await applyWrite(db, vehicleId, km)
  const historyId = await writeHistory(db, vehicleId, previous, km, source, opts)
  return { ok: true, previous, current: km, changed: true, historyId }
}

async function applyWrite(db: mysql.Pool, vehicleId: number, km: number): Promise<void> {
  await db.query(
    'UPDATE vehicles SET odometer_current = ?, odometer_recorded_at = NOW(), updated_at = NOW() WHERE id = ?',
    [km, vehicleId],
  )
}

async function writeHistory(
  db: mysql.Pool,
  vehicleId: number,
  previous: number | null,
  newKm: number,
  source: OdometerSource,
  opts: BumpOdometerOptions,
): Promise<number> {
  const [res] = await db.query<any>(
    `INSERT INTO odometer_history
       (vehicle_id, previous_km, new_km, source, actor_type, actor_id, source_ref, notes, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      vehicleId,
      previous,
      newKm,
      source,
      opts.actorType,
      opts.actorId ?? null,
      opts.sourceRef ?? null,
      opts.notes ?? null,
    ],
  )
  return Number(res.insertId)
}
