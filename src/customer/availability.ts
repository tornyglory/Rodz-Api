import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, validationError, serverError } from '../shared/errors'
import { getCustomerContext } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  getCustomerContext(event) // validates JWT, throws if invalid
  const db = getPool()

  const { storeId, month } = event.queryStringParameters ?? {}
  if (!storeId)                                    return validationError('storeId is required.')
  if (!month || !/^\d{4}-\d{2}$/.test(month))     return validationError('month must be YYYY-MM format.')

  const storeIdNum = Number(storeId)

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id, name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeIdNum],
    )
    if (!store) return validationError('Invalid storeId.')

    const [year, mon] = month.split('-').map(Number)
    const firstDay = `${month}-01`
    const lastDay  = new Date(year, mon, 0).toISOString().slice(0, 10)

    const [hoistResult, hoursResult, bookingsResult] = await Promise.all([
      db.query<any[]>('SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1', [storeIdNum]),
      db.query<any[]>('SELECT day_of_week, is_closed, open_time, close_time, last_booking_offset_mins FROM business_hours WHERE store_id = ? ORDER BY day_of_week', [storeIdNum]),
      db.query<any[]>(
        `SELECT booking_date, slot, COUNT(*) AS booked FROM bookings
         WHERE store_id = ? AND booking_date BETWEEN ? AND ?
           AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
         GROUP BY booking_date, slot`,
        [storeIdNum, firstDay, lastDay],
      ),
    ])

    const hoistCount = Number(hoistResult[0][0]?.hoist_count ?? 0)
    function toMins(t: string) { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m }
    const MORNING_MINS   = toMins('09:00')
    const AFTERNOON_MINS = toMins('13:00')

    const closedDays = new Set<number>(), noMorningDays = new Set<number>(), noAfternoonDays = new Set<number>()
    for (const row of hoursResult[0]) {
      const dow = Number(row.day_of_week)
      if (row.is_closed) { closedDays.add(dow); continue }
      if (row.open_time && row.close_time) {
        const openMins        = toMins(row.open_time)
        const lastBookingMins = toMins(row.close_time) - Number(row.last_booking_offset_mins ?? 0)
        if (MORNING_MINS   < openMins || MORNING_MINS   > lastBookingMins) noMorningDays.add(dow)
        if (AFTERNOON_MINS < openMins || AFTERNOON_MINS > lastBookingMins) noAfternoonDays.add(dow)
      }
    }
    const hasHours = hoursResult[0].length > 0
    const closureDates = new Set<string>(
      store.closure_dates
        ? (typeof store.closure_dates === 'string' ? JSON.parse(store.closure_dates) : store.closure_dates)
        : [],
    )

    const bookingCounts = new Map<string, number>()
    for (const row of bookingsResult[0]) {
      const d = row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : String(row.booking_date).slice(0, 10)
      bookingCounts.set(`${d}|${row.slot}`, Number(row.booked))
    }

    const today  = new Date().toISOString().slice(0, 10)
    const days: Record<string, { open: boolean; morning: number; afternoon: number }> = {}
    const cursor = new Date(`${firstDay}T00:00:00`)
    const end    = new Date(`${lastDay}T00:00:00`)

    while (cursor <= end) {
      const dateStr  = cursor.toISOString().slice(0, 10)
      const jsDow    = cursor.getDay()
      const isoDow   = jsDow === 0 ? 6 : jsDow - 1
      const isPast   = dateStr <= today
      const isClosed = closureDates.has(dateStr) || (hasHours ? closedDays.has(isoDow) : false)

      if (isPast || isClosed) {
        days[dateStr] = { open: false, morning: 0, afternoon: 0 }
      } else {
        days[dateStr] = {
          open:      true,
          morning:   (hasHours && noMorningDays.has(isoDow))   ? 0 : Math.max(0, hoistCount - (bookingCounts.get(`${dateStr}|morning`)   ?? 0)),
          afternoon: (hasHours && noAfternoonDays.has(isoDow)) ? 0 : Math.max(0, hoistCount - (bookingCounts.get(`${dateStr}|afternoon`) ?? 0)),
        }
      }
      cursor.setDate(cursor.getDate() + 1)
    }

    return ok({ storeId: storeIdNum, storeName: store.name, month, days })
  } catch (err) {
    return serverError(err)
  }
}
