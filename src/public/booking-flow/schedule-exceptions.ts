import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/stores/{id}/schedule-exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-day overrides on the weekly business_hours template — public
// holidays, staff training days, custom Christmas hours, etc. Feeds
// the guest date picker so it can tooltip explanations on the greyed
// days.
//
// Defaults: from = today, to = today + 90 days. Both inclusive.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const storeId = Number(event.pathParameters?.id)
  if (!Number.isInteger(storeId) || storeId <= 0) {
    return badRequest('store id must be a positive integer.')
  }

  const qs = event.queryStringParameters ?? {}
  const rawFrom = qs.from ?? today()
  const rawTo   = qs.to   ?? addDays(today(), 90)

  if (!ISO_DATE.test(rawFrom)) return badRequest('from must be a YYYY-MM-DD date.')
  if (!ISO_DATE.test(rawTo))   return badRequest('to must be a YYYY-MM-DD date.')
  if (rawFrom > rawTo)         return badRequest('from must be <= to.')

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeId],
    )
    if (!store) return notFound('Store')

    const [rows] = await db.query<any[]>(
      `SELECT date, is_closed,
              TIME_FORMAT(open_time,  '%H:%i') AS open_time,
              TIME_FORMAT(close_time, '%H:%i') AS close_time,
              reason
       FROM store_schedule_exceptions
       WHERE store_id = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
      [storeId, rawFrom, rawTo],
    )

    const exceptions = rows.map((r: any) => ({
      date:      r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      isClosed:  !!r.is_closed,
      openTime:  r.is_closed ? null : (r.open_time  ?? null),
      closeTime: r.is_closed ? null : (r.close_time ?? null),
      reason:    r.reason ?? null,
    }))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=3600',
      },
      body: JSON.stringify({ storeId, from: rawFrom, to: rawTo, exceptions }),
    }
  } catch (err) {
    return serverError(err)
  }
}
