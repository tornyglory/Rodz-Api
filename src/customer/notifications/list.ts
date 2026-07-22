import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// GET /c/notifications?limit=20&cursor=<lastId>
//
// Paginated, newest-first. `cursor` is the last `id` seen — send it back
// on the next call to fetch the older page. `nextCursor` is null when the
// caller has reached the end.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  const q = event.queryStringParameters ?? {}
  const limit  = Math.min(100, Math.max(1, Number(q.limit) || 20))
  const cursor = q.cursor ? Number(q.cursor) : null

  try {
    const params: any[] = [ctx.customerId]
    let where = 'customer_id = ?'
    if (cursor) { where += ' AND id < ?'; params.push(cursor) }
    params.push(limit + 1)   // fetch one extra to detect a next page

    const [rows] = await db.query<any[]>(
      `SELECT id, vehicle_id, event_id, type, title, body, deeplink, sent_at, read_at
       FROM notification_events
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ?`,
      params,
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return ok({
      notifications: page.map(r => ({
        id:        Number(r.id),
        vehicleId: r.vehicle_id != null ? Number(r.vehicle_id) : null,
        eventId:   String(r.event_id),
        type:      String(r.type),
        title:     String(r.title),
        body:      String(r.body),
        deeplink:  String(r.deeplink),
        sentAt:    r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at),
        readAt:    r.read_at ? (r.read_at instanceof Date ? r.read_at.toISOString() : String(r.read_at)) : null,
      })),
      nextCursor: hasMore ? Number(page[page.length - 1].id) : null,
    })
  } catch (err) {
    return serverError(err)
  }
}
