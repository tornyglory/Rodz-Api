import type { Pool } from 'mysql2/promise'

// Shared helpers for the store_booking_slots table + availability logic.
// Used by the customer availability endpoint and the customer booking
// create endpoint (to validate the requested time is a real active slot).

export interface Slot {
  id:         number
  storeId:    number
  time:       string    // 'HH:MM:SS' as stored
  label:      string | null
  sortOrder:  number
  isActive:   boolean
}

export function shapeSlot(row: any): Slot {
  const t = row.slot_time
  return {
    id:        Number(row.id),
    storeId:   Number(row.store_id),
    time:      t instanceof Date ? t.toISOString().slice(11, 19) : String(t).slice(0, 8),
    label:     row.label ?? null,
    sortOrder: Number(row.sort_order),
    isActive:  Number(row.is_active) === 1,
  }
}

// Returns HH:MM for the client — the storage-form is HH:MM:SS.
export function toHHMM(time: string): string {
  return String(time).slice(0, 5)
}

// Load every active slot for a store, ordered as staff configured them.
export async function loadActiveSlots(db: Pool, storeId: number): Promise<Slot[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, store_id, slot_time, label, sort_order, is_active
     FROM store_booking_slots
     WHERE store_id = ? AND is_active = 1
     ORDER BY sort_order ASC, slot_time ASC`,
    [storeId],
  )
  return rows.map(shapeSlot)
}

// Verify a client-supplied 'HH:MM' matches an active slot at this store.
// Returns the Slot row on match, null on miss.
export async function findActiveSlotByTime(
  db: Pool,
  storeId: number,
  hhmm: string,
): Promise<Slot | null> {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null
  const [[row]] = await db.query<any[]>(
    `SELECT id, store_id, slot_time, label, sort_order, is_active
     FROM store_booking_slots
     WHERE store_id = ? AND is_active = 1 AND slot_time = ?
     LIMIT 1`,
    [storeId, `${hhmm}:00`],
  )
  return row ? shapeSlot(row) : null
}

// Map a booking time to the legacy `bookings.slot` enum so existing code
// paths (reports, staff app, AI agent) that still read `slot` keep working.
export function deriveSlotEnum(hhmm: string): 'morning' | 'afternoon' {
  const hour = Number(hhmm.slice(0, 2))
  return hour < 12 ? 'morning' : 'afternoon'
}

// Per-day availability check for a store.
//
// Returns each slot with an `available` boolean. A slot is unavailable when:
//   • The store is closed that day of week (business_hours.is_closed = 1)
//   • The slot end time (slot + 60 min default) exceeds business_hours.close_time
//     minus last_booking_offset_mins
//   • The number of live bookings at that time equals the store's hoist count
export async function computeSlotAvailability(
  db: Pool,
  storeId: number,
  date: string,     // YYYY-MM-DD
): Promise<{
  storeOpen: boolean
  reason?: 'closed_dow' | 'past_date' | 'closed_exception'
  exceptionReason?: string | null
  slots: Array<Slot & { available: boolean; reason?: string }>
}> {
  const today = new Date().toISOString().slice(0, 10)
  if (date <= today) {
    return { storeOpen: false, reason: 'past_date', slots: [] }
  }

  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()   // 0 = Sun

  // Check for a per-date override first — closures and custom-hours days.
  const [[exception]] = await db.query<any[]>(
    `SELECT is_closed, open_time, close_time, reason
     FROM store_schedule_exceptions WHERE store_id = ? AND date = ? LIMIT 1`,
    [storeId, date],
  )

  const [[dowHours]] = await db.query<any[]>(
    `SELECT is_closed, open_time, close_time, last_booking_offset_mins
     FROM business_hours WHERE store_id = ? AND day_of_week = ? LIMIT 1`,
    [storeId, dow],
  )

  const slots = await loadActiveSlots(db, storeId)

  // Exception says closed → whole day is off, regardless of dow hours.
  if (exception && Number(exception.is_closed) === 1) {
    return {
      storeOpen:       false,
      reason:          'closed_exception',
      exceptionReason: exception.reason ?? null,
      slots:           slots.map(s => ({ ...s, available: false, reason: 'closed_exception' })),
    }
  }

  // Effective hours: exception open/close overrides dow when both present.
  const hours: any = exception && Number(exception.is_closed) === 0
    ? {
        is_closed:                0,
        open_time:                exception.open_time,
        close_time:               exception.close_time,
        last_booking_offset_mins: dowHours?.last_booking_offset_mins ?? 60,
      }
    : dowHours

  if (!hours || Number(hours.is_closed) === 1) {
    return {
      storeOpen: false,
      reason:    'closed_dow',
      slots:     slots.map(s => ({ ...s, available: false, reason: 'store_closed' })),
    }
  }

  const [[hoistRow]] = await db.query<any[]>(
    'SELECT COUNT(*) AS n FROM hoists WHERE store_id = ? AND is_active = 1',
    [storeId],
  )
  const hoistCount = Number(hoistRow?.n ?? 0)

  const [bookedRows] = await db.query<any[]>(
    `SELECT booking_time, COUNT(*) AS n FROM bookings
     WHERE store_id = ? AND booking_date = ?
       AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
     GROUP BY booking_time`,
    [storeId, date],
  )
  const bookedByTime = new Map<string, number>()
  for (const r of bookedRows) {
    const t = r.booking_time instanceof Date
      ? r.booking_time.toISOString().slice(11, 19)
      : String(r.booking_time).slice(0, 8)
    bookedByTime.set(t, Number(r.n))
  }

  // Cutoff for last booking: close_time - last_booking_offset_mins.
  const closeStr  = String(hours.close_time ?? '17:30:00').slice(0, 5)
  const offsetMin = Number(hours.last_booking_offset_mins ?? 60)
  const [ch, cm] = closeStr.split(':').map(Number)
  const cutoffMin = ch * 60 + cm - offsetMin
  const openStr   = String(hours.open_time ?? '08:30:00').slice(0, 5)
  const [oh, om]  = openStr.split(':').map(Number)
  const openMin   = oh * 60 + om

  const withAvailability = slots.map(s => {
    const [sh, sm] = s.time.slice(0, 5).split(':').map(Number)
    const startMin = sh * 60 + sm

    if (startMin < openMin)       return { ...s, available: false, reason: 'before_open' }
    if (startMin + 60 > cutoffMin + offsetMin) return { ...s, available: false, reason: 'after_close' }
    if (startMin > cutoffMin)     return { ...s, available: false, reason: 'past_cutoff' }

    const booked = bookedByTime.get(`${s.time.slice(0, 5)}:00`) ?? 0
    if (hoistCount > 0 && booked >= hoistCount) {
      return { ...s, available: false, reason: 'full' }
    }
    return { ...s, available: true }
  })

  return { storeOpen: true, slots: withAvailability }
}
