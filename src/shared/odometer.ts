import type mysql from 'mysql2/promise'

// One source of truth for vehicle mileage: `vehicles.odometer_current`.
// Every writer routes through this helper so the value can never decrease
// once set. Callers decide whether a backwards reading is a hard error
// (surface 422 to the user) or a soft no-op (fuel-fill / expense / job
// snapshots that happen to be older than the current reading).

export type OdometerSource =
  | 'staff'          // staff-side vehicle PATCH
  | 'customer'       // customer-side vehicle PATCH
  | 'job'            // workshop job entry (odometer_in)
  | 'fuel-fill'      // customer fuel-fill snapshot
  | 'expense'        // customer expense snapshot
  | 'logbook'        // customer logbook entry (past service)

export type BumpResult =
  | { ok: true; previous: number | null; current: number; changed: boolean }
  | { ok: false; reason: 'backwards'; previous: number; attempted: number }
  | { ok: false; reason: 'not_found' }

/**
 * Set the vehicle's `odometer_current` to `newKm` if it's higher than the
 * existing value. Never lowers the odometer.
 *
 * - `newKm > current` (or current is null) → writes, stamps `odometer_recorded_at`
 * - `newKm === current` → no-op, `changed: false`
 * - `newKm < current`   → `{ ok: false, reason: 'backwards' }`
 * - vehicle missing     → `{ ok: false, reason: 'not_found' }`
 *
 * Non-negative + finite is enforced. Callers should pre-validate for a
 * friendlier error message where relevant.
 */
export async function bumpOdometer(
  db: mysql.Pool,
  vehicleId: number,
  newKm: number,
  // Reserved for a future audit-log follow-up. Not persisted today.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _source: OdometerSource,
): Promise<BumpResult> {
  if (!Number.isFinite(newKm) || newKm < 0) {
    return { ok: false, reason: 'backwards', previous: 0, attempted: newKm }
  }
  const km = Math.floor(newKm)

  const [[row]] = await db.query<any[]>(
    'SELECT odometer_current FROM vehicles WHERE id = ? LIMIT 1',
    [vehicleId],
  )
  if (!row) return { ok: false, reason: 'not_found' }

  const previous: number | null = row.odometer_current != null ? Number(row.odometer_current) : null

  if (previous != null && km < previous) {
    return { ok: false, reason: 'backwards', previous, attempted: km }
  }
  if (previous === km) {
    return { ok: true, previous, current: km, changed: false }
  }

  await db.query(
    'UPDATE vehicles SET odometer_current = ?, odometer_recorded_at = NOW(), updated_at = NOW() WHERE id = ?',
    [km, vehicleId],
  )

  return { ok: true, previous, current: km, changed: true }
}
