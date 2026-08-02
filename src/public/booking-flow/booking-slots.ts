import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'
import { loadEligibleHoists, HoistTech } from '../../shared/bookingSlots'

const ready = bootstrap()

// GET /public/stores/{id}/booking-slots?date=YYYY-MM-DD
//
// Per-day slot list for the guest booking flow's time picker. Every
// active slot is returned; unavailable ones carry a `reason` explaining
// why so the UI can show them disabled with a tooltip.
//
// storeOpen semantics:
//   - `false` + reason=past_date        → date is in the past
//   - `false` + reason=closed_dow       → weekly template says closed
//   - `false` + reason=closed_exception → schedule_exceptions says closed
//   - `true`                            → store takes bookings that day
//
// Per-slot `reason` values:
//   - store_closed → whole day is closed (mirrors top-level reason)
//   - before_open  → slot starts before store open time
//   - after_close  → slot starts at or after store close time
//   - past_cutoff  → slot starts within lastBookingOffsetMins of close,
//                    OR (for today) the slot time has already passed
//   - full         → hoist capacity reached for this slot

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// "Now" in the store's timezone as {isoDate, hhmm}. Everything the
// handler compares against (past_date, past_cutoff, today-vs-future)
// needs to be in store-local time — otherwise a customer in
// Melbourne querying for "today" at 11pm gets an off-by-one-day
// result because UTC has already ticked over.
function nowInStoreTz(timezone: string): { isoDate: string; hhmm: string } {
  const tz = timezone || 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return {
    isoDate: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm:    `${get('hour')}:${get('minute')}`,
  }
}

// JS getUTCDay() returns 0=Sunday, matches DB convention.
function dayOfWeek(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getUTCDay()
}

interface SlotRow {
  id:         number
  slot_time:  string   // "HH:MM"
  end_time:   string   // "HH:MM"
  label:      string | null
  sort_order: number
}

interface SlotTech {
  hoistId:   number
  hoistName: string
  staffId:   number | null
  name:      string | null
}

interface Slot {
  id:        number
  time:      string
  endTime:   string
  label:     string | null
  sortOrder: number
  available: boolean
  reason:    string | null
  techs:     SlotTech[]
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const storeId = Number(event.pathParameters?.id)
  if (!Number.isInteger(storeId) || storeId <= 0) return badRequest('store id must be a positive integer.')

  const date = event.queryStringParameters?.date
  if (!date || !ISO_DATE.test(date)) return badRequest('date query param is required as YYYY-MM-DD.')

  // Optional service filter. When provided, only hoists whose
  // service_roles cover every requested service appear in `techs`.
  const rawSvc = event.queryStringParameters?.serviceTypeIds ?? ''
  const serviceTypeIds = rawSvc
    ? String(rawSvc).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : undefined

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id, name, timezone FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeId],
    )
    if (!store) return notFound('Store')

    const now = nowInStoreTz(store.timezone)

    // Always fetch the slot list — brief says "render every slot,
    // disabled when unavailable" — so we return the list regardless of
    // whether the store is open that day.
    const [slotRows] = await db.query<any[]>(
      `SELECT id,
              TIME_FORMAT(slot_time, '%H:%i') AS slot_time,
              TIME_FORMAT(end_time,  '%H:%i') AS end_time,
              label, sort_order
       FROM store_booking_slots
       WHERE store_id = ? AND is_active = 1
       ORDER BY sort_order ASC, slot_time ASC`,
      [storeId],
    )
    const slots: SlotRow[] = slotRows.map((r: any) => ({
      id:         Number(r.id),
      slot_time:  r.slot_time,
      end_time:   r.end_time,
      label:      r.label ?? null,
      sort_order: Number(r.sort_order),
    }))

    // Past date → whole day unavailable, every slot store_closed.
    if (date < now.isoDate) {
      return jsonOk({
        store:     { id: Number(store.id), name: store.name },
        date,
        storeOpen: false,
        reason:    'past_date',
        slots:     slots.map(s => shapeUnavailable(s, 'store_closed')),
      })
    }

    // Weekly template for that day-of-week.
    const dow = dayOfWeek(date)
    const [[bh]] = await db.query<any[]>(
      `SELECT is_closed,
              TIME_FORMAT(open_time,  '%H:%i') AS open_time,
              TIME_FORMAT(close_time, '%H:%i') AS close_time,
              last_booking_offset_mins
       FROM business_hours WHERE store_id = ? AND day_of_week = ? LIMIT 1`,
      [storeId, dow],
    )

    // One-off override for that specific date (holidays, custom hours,
    // early closures). Takes precedence over the weekly template.
    const [[ex]] = await db.query<any[]>(
      `SELECT is_closed,
              TIME_FORMAT(open_time,  '%H:%i') AS open_time,
              TIME_FORMAT(close_time, '%H:%i') AS close_time,
              reason
       FROM store_schedule_exceptions
       WHERE store_id = ? AND date = ? LIMIT 1`,
      [storeId, date],
    )

    // Resolve effective open/close/offset for this date.
    const closed  = ex ? !!ex.is_closed : !!bh?.is_closed
    const openTM  = ex && !ex.is_closed ? (ex.open_time  ?? bh?.open_time)  : bh?.open_time
    const closeTM = ex && !ex.is_closed ? (ex.close_time ?? bh?.close_time) : bh?.close_time
    const offsetMins = bh?.last_booking_offset_mins != null ? Number(bh.last_booking_offset_mins) : 0

    if (closed || !openTM || !closeTM) {
      const topReason = ex?.is_closed ? 'closed_exception' : 'closed_dow'
      return jsonOk({
        store:     { id: Number(store.id), name: store.name },
        date,
        storeOpen: false,
        reason:    topReason,
        slots:     slots.map(s => shapeUnavailable(s, 'store_closed')),
      })
    }

    // Store is open. Compute availability per slot.
    const openMin      = toMinutes(openTM)
    const closeMin     = toMinutes(closeTM)
    const cutoffMin    = closeMin - offsetMins
    const isToday      = date === now.isoDate
    const nowMin       = toMinutes(now.hhmm)

    // Per-slot occupancy tracked by (time → set of booked hoist_ids) so we
    // can compute which specific hoists are free at each slot, not just a
    // raw count. `cancelled_at` is the primary "this doesn't count" signal;
    // status enum catches admin rejections + no-shows too.
    const [bookingRows] = await db.query<any[]>(
      `SELECT TIME_FORMAT(booking_time, '%H:%i') AS slot_time, hoist_id
       FROM bookings
       WHERE store_id = ?
         AND booking_date = ?
         AND cancelled_at IS NULL
         AND status NOT IN ('cancelled', 'rejected', 'no_show')`,
      [storeId, date],
    )
    const bookedHoistsByTime = new Map<string, Set<number>>()
    for (const r of bookingRows) {
      if (!bookedHoistsByTime.has(r.slot_time)) bookedHoistsByTime.set(r.slot_time, new Set())
      if (r.hoist_id != null) bookedHoistsByTime.get(r.slot_time)!.add(Number(r.hoist_id))
    }

    // Eligible hoists (filtered by requested service_roles when provided),
    // joined to their assigned technician for the response's `techs` array.
    const eligibleHoists = await loadEligibleHoists(db, storeId, serviceTypeIds)

    const shapedSlots: Slot[] = slots.map(s => {
      const slotMin = toMinutes(s.slot_time)

      if (slotMin < openMin)                      return shapeUnavailable(s, 'before_open')
      if (slotMin >= closeMin)                    return shapeUnavailable(s, 'after_close')
      if (slotMin > cutoffMin)                    return shapeUnavailable(s, 'past_cutoff')
      if (isToday && slotMin <= nowMin)           return shapeUnavailable(s, 'past_cutoff')

      const bookedHoistIds = bookedHoistsByTime.get(s.slot_time) ?? new Set<number>()
      const freeTechs      = eligibleHoists.filter(h => !bookedHoistIds.has(h.hoistId))

      if (freeTechs.length === 0) return shapeUnavailable(s, 'full')

      return {
        id:        s.id,
        time:      s.slot_time,
        endTime:   s.end_time,
        label:     s.label,
        sortOrder: s.sort_order,
        available: true,
        reason:    null,
        techs:     freeTechs.map(shapeTech),
      }
    })

    return jsonOk({
      store:     { id: Number(store.id), name: store.name },
      date,
      storeOpen: true,
      reason:    null,
      slots:     shapedSlots,
    })
  } catch (err) {
    return serverError(err)
  }
}

function shapeUnavailable(s: SlotRow, reason: string): Slot {
  return {
    id:        s.id,
    time:      s.slot_time,
    endTime:   s.end_time,
    label:     s.label,
    sortOrder: s.sort_order,
    available: false,
    reason,
    techs:     [],
  }
}

function shapeTech(h: HoistTech): SlotTech {
  return {
    hoistId:   h.hoistId,
    hoistName: h.hoistName,
    staffId:   h.staffId,
    name:      h.name,           // null when the hoist has no assigned tech
  }
}

function jsonOk(body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'application/json',
      // Availability changes as bookings land — short client cache is
      // fine, edge cache keyed on ?date= so multiple visitors hitting
      // the same day share the compute.
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
    body: JSON.stringify(body),
  }
}
