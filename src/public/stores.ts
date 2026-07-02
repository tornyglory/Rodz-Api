import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

const unauthorized = (): APIGatewayProxyResultV2 => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Unauthorized' }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (event.headers['x-api-key'] !== process.env.BOOKING_API_KEY) return unauthorized()
  const db = getPool()

  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

  try {
    const [storeRows] = await db.query<any[]>(
      'SELECT id, name, closure_dates FROM stores WHERE is_active = 1 ORDER BY name',
    )

    const [hoursRows] = await db.query<any[]>(
      `SELECT store_id, day_of_week, is_closed,
              TIME_FORMAT(open_time, '%H:%i') AS open_time,
              TIME_FORMAT(close_time, '%H:%i') AS close_time,
              last_booking_offset_mins
       FROM business_hours ORDER BY store_id, day_of_week`,
    )

    const hoursByStore = new Map<number, any[]>()
    for (const row of hoursRows) {
      const sid = Number(row.store_id)
      if (!hoursByStore.has(sid)) hoursByStore.set(sid, [])
      hoursByStore.get(sid)!.push(row)
    }

    const stores = storeRows.map((s) => {
      const hours = hoursByStore.get(Number(s.id)) ?? []
      const closureDates: string[] = s.closure_dates
        ? (typeof s.closure_dates === 'string' ? JSON.parse(s.closure_dates) : s.closure_dates)
        : []

      return {
        id:           s.id,
        name:         s.name,
        closureDates,
        businessHours: DAY_NAMES.map((day, dow) => {
          const h = hours.find((r) => Number(r.day_of_week) === dow)
          if (!h || h.is_closed) return { dayOfWeek: dow, day, isOpen: false, openTime: null, closeTime: null, lastBookingOffsetMins: null }
          return {
            dayOfWeek:            dow,
            day,
            isOpen:               true,
            openTime:             h.open_time,
            closeTime:            h.close_time,
            lastBookingOffsetMins: Number(h.last_booking_offset_mins),
          }
        }),
      }
    })

    return ok({ stores })
  } catch (err) {
    return serverError(err)
  }
}
