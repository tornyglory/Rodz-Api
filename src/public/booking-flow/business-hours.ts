import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/stores/{id}/business-hours
//
// Public projection of the 7-day weekly template for a store. Feeds
// the guest booking flow's date picker so it can grey out
// permanently-closed weekdays without a round-trip per date.
//
// Day-of-week convention: 0 = Sunday, per the brief and the underlying
// seed data. (The legacy authed /public/stores handler labels day 0 as
// Monday, which is a bug in that handler — not touching it here.)

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const storeId = Number(event.pathParameters?.id)
  if (!Number.isInteger(storeId) || storeId <= 0) {
    return badRequest('store id must be a positive integer.')
  }

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeId],
    )
    if (!store) return notFound('Store')

    const [rows] = await db.query<any[]>(
      `SELECT day_of_week, is_closed,
              TIME_FORMAT(open_time,  '%H:%i') AS open_time,
              TIME_FORMAT(close_time, '%H:%i') AS close_time,
              last_booking_offset_mins
       FROM business_hours
       WHERE store_id = ?
       ORDER BY day_of_week ASC`,
      [storeId],
    )

    const hours = rows.map((r: any) => ({
      dayOfWeek:             Number(r.day_of_week),
      openTime:              r.is_closed ? null : (r.open_time  ?? null),
      closeTime:             r.is_closed ? null : (r.close_time ?? null),
      isClosed:              !!r.is_closed,
      lastBookingOffsetMins: r.last_booking_offset_mins != null ? Number(r.last_booking_offset_mins) : null,
    }))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=86400',
      },
      body: JSON.stringify({ storeId, hours }),
    }
  } catch (err) {
    return serverError(err)
  }
}
