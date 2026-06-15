import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

function err422(message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 422,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message } }),
  }
}

const unauthorized = (): APIGatewayProxyResultV2 => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Unauthorized' }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (event.headers['x-api-key'] !== process.env.BOOKING_API_KEY) return unauthorized()
  const db = getPool()

  try {
    const { storeId, month } = event.queryStringParameters ?? {}

    if (!storeId) return err422('storeId is required.')
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return err422('month must be in YYYY-MM format.')

    const storeIdNum = Number(storeId)

    // Verify store exists
    const [[store]] = await db.query<any[]>('SELECT id FROM stores WHERE id = ? LIMIT 1', [storeIdNum])
    if (!store) return err422('Invalid storeId.')

    // Date range for the month
    const [year, mon] = month.split('-').map(Number)
    const firstDay = `${month}-01`
    const lastDay  = new Date(year, mon, 0).toISOString().slice(0, 10) // last day of month

    // Run queries in parallel
    const [hoistResult, hoursResult, bookingsResult] = await Promise.all([
      // Hoist capacity
      db.query<any[]>(
        'SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1',
        [storeIdNum],
      ),
      // Business hours — which days of the week are open (day_of_week: 0=Mon...6=Sun)
      db.query<any[]>(
        'SELECT day_of_week, is_closed FROM business_hours WHERE store_id = ? ORDER BY day_of_week',
        [storeIdNum],
      ),
      // Existing bookings in the month by date + slot
      db.query<any[]>(
        `SELECT booking_date, slot, COUNT(*) AS booked
         FROM bookings
         WHERE store_id = ?
           AND booking_date BETWEEN ? AND ?
           AND cancelled_at IS NULL
           AND status NOT IN ('rejected', 'cancelled')
         GROUP BY booking_date, slot`,
        [storeIdNum, firstDay, lastDay],
      ),
    ])

    const hoistCount: number = Number(hoistResult[0][0]?.hoist_count ?? 0)

    // Build a lookup of closed days (day_of_week values where is_closed = 1)
    // business_hours day_of_week: assume 0=Monday...6=Sunday (ISO weekday - 1)
    const closedDays = new Set<number>()
    for (const row of hoursResult[0]) {
      if (row.is_closed) closedDays.add(Number(row.day_of_week))
    }
    const hasBusinessHours = hoursResult[0].length > 0

    // Build a booking count lookup: "date|slot" → count
    const bookingCounts = new Map<string, number>()
    for (const row of bookingsResult[0]) {
      const d = row.booking_date instanceof Date
        ? row.booking_date.toISOString().slice(0, 10)
        : String(row.booking_date).slice(0, 10)
      bookingCounts.set(`${d}|${row.slot}`, Number(row.booked))
    }

    // Build availability for every day in the month
    const days: Record<string, { open: boolean; morning: number; afternoon: number }> = {}
    const today = new Date().toISOString().slice(0, 10)

    const cursor = new Date(`${firstDay}T00:00:00`)
    const end    = new Date(`${lastDay}T00:00:00`)

    while (cursor <= end) {
      const dateStr  = cursor.toISOString().slice(0, 10)
      // JS getDay(): 0=Sun, 1=Mon...6=Sat → convert to 0=Mon...6=Sun
      const jsDow    = cursor.getDay()
      const isoDow   = jsDow === 0 ? 6 : jsDow - 1

      const isPast   = dateStr <= today
      const isClosed = hasBusinessHours ? closedDays.has(isoDow) : false

      if (isPast || isClosed) {
        days[dateStr] = { open: false, morning: 0, afternoon: 0 }
      } else {
        const morningBooked   = bookingCounts.get(`${dateStr}|morning`)   ?? 0
        const afternoonBooked = bookingCounts.get(`${dateStr}|afternoon`) ?? 0
        days[dateStr] = {
          open:      true,
          morning:   Math.max(0, hoistCount - morningBooked),
          afternoon: Math.max(0, hoistCount - afternoonBooked),
        }
      }

      cursor.setDate(cursor.getDate() + 1)
    }

    return ok({ storeId: storeIdNum, month, hoistCapacity: hoistCount, days })
  } catch (err) {
    return serverError(err)
  }
}
