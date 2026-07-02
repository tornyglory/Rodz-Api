import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const DEFAULT_BLOCK_TIMES = ['08:00', '10:00', '13:00', '15:00']

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
    const { storeId, date } = event.queryStringParameters ?? {}

    if (!storeId) return err422('storeId is required.')
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err422('date must be in YYYY-MM-DD format.')

    const today = new Date().toISOString().slice(0, 10)
    if (date <= today) return err422('date must be a future date.')

    const storeIdNum = Number(storeId)

    const [[store]] = await db.query<any[]>(
      'SELECT id, block_times, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeIdNum],
    )
    if (!store) return err422('Invalid storeId.')

    // Check store-level one-off closure for this date
    const closureDates: string[] = store.closure_dates
      ? (typeof store.closure_dates === 'string' ? JSON.parse(store.closure_dates) : store.closure_dates)
      : []
    if (closureDates.includes(date)) {
      return ok({ storeId: storeIdNum, date, hoistCapacity: 0, blocks: [], closed: true })
    }

    const blockTimes: string[] = store.block_times
      ? (typeof store.block_times === 'string' ? JSON.parse(store.block_times) : store.block_times)
      : DEFAULT_BLOCK_TIMES

    // Check if store is open on this day
    const jsDate = new Date(`${date}T00:00:00`)
    const jsDow  = jsDate.getDay()              // 0=Sun, 1=Mon … 6=Sat
    const isoDow = jsDow === 0 ? 6 : jsDow - 1  // 0=Mon … 6=Sun

    const [[dayRow]] = await db.query<any[]>(
      `SELECT is_closed, open_time, close_time, last_booking_offset_mins
       FROM business_hours WHERE store_id = ? AND day_of_week = ? LIMIT 1`,
      [storeIdNum, isoDow],
    )
    if (dayRow?.is_closed) {
      return ok({ storeId: storeIdNum, date, hoistCapacity: 0, blocks: [] })
    }

    // Active hoist count
    const [[{ hoist_count }]] = await db.query<any[]>(
      'SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1',
      [storeIdNum],
    )
    const hoistCount = Number(hoist_count ?? 0)

    // Bookings by time on this date
    const [bookingRows] = await db.query<any[]>(
      `SELECT TIME_FORMAT(booking_time, '%H:%i') AS btime, COUNT(*) AS booked
       FROM bookings
       WHERE store_id = ? AND booking_date = ?
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY booking_time`,
      [storeIdNum, date],
    )

    const bookedByTime = new Map<string, number>()
    for (const row of bookingRows) {
      bookedByTime.set(row.btime, Number(row.booked))
    }

    // Filter blocks to those within business hours
    function toMins(t: string) {
      const [h, m] = t.slice(0, 5).split(':').map(Number)
      return h * 60 + m
    }
    let eligibleBlocks = blockTimes
    if (dayRow?.open_time && dayRow?.close_time) {
      const openMins        = toMins(dayRow.open_time)
      const lastBookingMins = toMins(dayRow.close_time) - Number(dayRow.last_booking_offset_mins ?? 0)
      eligibleBlocks = blockTimes.filter(t => {
        const m = toMins(t)
        return m >= openMins && m <= lastBookingMins
      })
    }

    const blocks = eligibleBlocks.map((time: string) => ({
      time,
      available: Math.max(0, hoistCount - (bookedByTime.get(time) ?? 0)),
    }))

    return ok({ storeId: storeIdNum, date, hoistCapacity: hoistCount, blocks })
  } catch (err) {
    return serverError(err)
  }
}
