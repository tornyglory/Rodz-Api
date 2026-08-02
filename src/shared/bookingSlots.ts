import type { Pool } from 'mysql2/promise'

// Shared helpers for the store_booking_slots table + availability logic.
// Used by the customer availability endpoint and the customer booking
// create endpoint (to validate the requested time is a real active slot).

export interface Slot {
  id:         number
  storeId:    number
  time:       string    // start, 'HH:MM:SS' as stored
  endTime:    string    // end,   'HH:MM:SS'
  label:      string | null
  sortOrder:  number
  isActive:   boolean
}

function toHHMMSS(v: any): string {
  return v instanceof Date ? v.toISOString().slice(11, 19) : String(v).slice(0, 8)
}

export function shapeSlot(row: any): Slot {
  return {
    id:        Number(row.id),
    storeId:   Number(row.store_id),
    time:      toHHMMSS(row.slot_time),
    endTime:   toHHMMSS(row.end_time),
    label:     row.label ?? null,
    sortOrder: Number(row.sort_order),
    isActive:  Number(row.is_active) === 1,
  }
}

// Minutes-from-midnight helper for TIME arithmetic.
export function minsFromHHMM(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  return h * 60 + m
}

// Coarse mapping from service_types.category → the hoist.service_roles
// strings that qualify to perform that category of work. A hoist is
// eligible for a service if its service_roles array contains at least
// one role from the mapped set. Staff can refine per-service later by
// adding a dedicated role_slug column to service_types.
const SERVICE_CATEGORY_TO_ROLES: Record<string, string[]> = {
  service:    ['Oil & Filter', 'Full Service', 'Logbook Service', 'General Repairs'],
  tyres:      ['Tyre Fitting', 'Wheel Alignment'],
  brakes:     ['Brake Service', 'Full Service', 'General Repairs'],
  suspension: ['General Repairs', 'Full Service'],
  electrical: ['Electrical', 'General Repairs'],
  air_con:    ['General Repairs', 'Full Service'],
  exhaust:    ['General Repairs', 'Full Service'],
  inspection: ['General Repairs', 'Full Service'],
  repairs:    ['General Repairs', 'Full Service'],
  other:      ['General Repairs', 'Full Service'],
}

export interface HoistTech {
  hoistId:       number
  hoistName:     string
  staffId:       number | null
  name:          string | null      // technician display name; null when no tech assigned
  avatarImageId: string | null
}

// Load every active hoist at a store, joined to its assigned technician
// (nullable). If `serviceTypeIds` is provided, filter to hoists whose
// service_roles overlap the required roles for EVERY requested service.
export async function loadEligibleHoists(
  db: Pool,
  storeId: number,
  serviceTypeIds?: number[],
): Promise<HoistTech[]> {
  const [rows] = await db.query<any[]>(
    `SELECT h.id, h.name, h.service_roles,
            h.assigned_staff_id, s.first_name, s.last_name, s.avatar_image_id
     FROM hoists h
     LEFT JOIN staff s ON s.id = h.assigned_staff_id AND s.is_active = 1
     WHERE h.store_id = ? AND h.is_active = 1
     ORDER BY h.id`,
    [storeId],
  )

  // Derive the set of acceptable roles per requested service.
  let requiredRoleSets: Set<string>[] = []
  if (serviceTypeIds && serviceTypeIds.length > 0) {
    const ph = serviceTypeIds.map(() => '?').join(',')
    const [stRows] = await db.query<any[]>(
      `SELECT id, category FROM service_types WHERE id IN (${ph})`,
      serviceTypeIds,
    )
    requiredRoleSets = stRows.map(r => new Set(SERVICE_CATEGORY_TO_ROLES[String(r.category)] ?? []))
  }

  return rows
    .map(r => {
      const roles: string[] = (() => {
        try {
          return typeof r.service_roles === 'string'
            ? JSON.parse(r.service_roles)
            : Array.isArray(r.service_roles) ? r.service_roles : []
        } catch {
          return []
        }
      })()

      // Every requested service must be coverable by at least one of this hoist's roles.
      const covers = requiredRoleSets.every(need =>
        roles.some(r => need.has(r)),
      )
      return { row: r, roles, covers }
    })
    .filter(x => x.covers)
    .map(({ row: r }) => ({
      hoistId:       Number(r.id),
      hoistName:     String(r.name),
      staffId:       r.assigned_staff_id != null ? Number(r.assigned_staff_id) : null,
      name:          r.first_name && r.last_name ? `${r.first_name} ${r.last_name}` : null,
      avatarImageId: r.avatar_image_id ?? null,
    }))
}

// Returns HH:MM for the client — the storage-form is HH:MM:SS.
export function toHHMM(time: string): string {
  return String(time).slice(0, 5)
}

// Load every active slot for a store, ordered as staff configured them.
export async function loadActiveSlots(db: Pool, storeId: number): Promise<Slot[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, store_id, slot_time, end_time, label, sort_order, is_active
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
    `SELECT id, store_id, slot_time, end_time, label, sort_order, is_active
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
// Returns each slot with:
//   • available (boolean)
//   • techs (array of hoist+tech options that are free at that time)
//
// A slot is unavailable when:
//   • The store is closed that day of week or via exception
//   • The slot end time exceeds close_time minus last_booking_offset_mins
//   • No eligible hoist is free at that time
//
// When `serviceTypeIds` is provided, only hoists whose service_roles cover
// every requested service appear in `techs`.
export async function computeSlotAvailability(
  db: Pool,
  storeId: number,
  date: string,     // YYYY-MM-DD
  serviceTypeIds?: number[],
): Promise<{
  storeOpen: boolean
  reason?: 'closed_dow' | 'past_date' | 'closed_exception'
  exceptionReason?: string | null
  slots: Array<Slot & {
    available: boolean
    reason?: string
    techs: HoistTech[]
  }>
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
      slots:           slots.map(s => ({ ...s, available: false, reason: 'closed_exception', techs: [] })),
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
      slots:     slots.map(s => ({ ...s, available: false, reason: 'store_closed', techs: [] })),
    }
  }

  // Load the eligible hoists once (filtered by service_types if given), then
  // per-slot subtract any that are already booked at that specific time.
  const eligibleHoists = await loadEligibleHoists(db, storeId, serviceTypeIds)

  const [bookedRows] = await db.query<any[]>(
    `SELECT booking_time, hoist_id FROM bookings
     WHERE store_id = ? AND booking_date = ?
       AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')`,
    [storeId, date],
  )
  const bookedHoistsByTime = new Map<string, Set<number>>()
  for (const r of bookedRows) {
    const t = r.booking_time instanceof Date
      ? r.booking_time.toISOString().slice(11, 19)
      : String(r.booking_time).slice(0, 8)
    if (!bookedHoistsByTime.has(t)) bookedHoistsByTime.set(t, new Set())
    if (r.hoist_id != null) bookedHoistsByTime.get(t)!.add(Number(r.hoist_id))
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
    const startMin = minsFromHHMM(s.time)
    const endMin   = minsFromHHMM(s.endTime)
    const closeMin = cutoffMin + offsetMin   // actual close time-of-day

    if (startMin < openMin)   return { ...s, available: false, reason: 'before_open', techs: [] }
    if (endMin > closeMin)    return { ...s, available: false, reason: 'after_close', techs: [] }
    if (startMin > cutoffMin) return { ...s, available: false, reason: 'past_cutoff', techs: [] }

    const bookedHoistIds = bookedHoistsByTime.get(`${s.time.slice(0, 5)}:00`) ?? new Set<number>()
    const freeTechs      = eligibleHoists.filter(h => !bookedHoistIds.has(h.hoistId))

    if (freeTechs.length === 0) {
      return { ...s, available: false, reason: 'full', techs: [] }
    }
    return { ...s, available: true, techs: freeTechs }
  })

  return { storeOpen: true, slots: withAvailability }
}
