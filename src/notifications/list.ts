import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { staffId } = getAuthContext(event)
  const { unread } = event.queryStringParameters ?? {}

  try {
    let query = `
      SELECT id, type, title, body, store_id, booking_id, quote_id, job_id, invoice_id, read_at, created_at
      FROM staff_notifications WHERE staff_id = ?`
    const params: unknown[] = [staffId]

    if (unread === 'true') query += ' AND read_at IS NULL'

    query += ' ORDER BY created_at DESC LIMIT 50'

    const [rows] = await db.query<any[]>(query, params)

    const [[{ unreadCount }]] = await db.query<any[]>(
      'SELECT COUNT(*) AS unreadCount FROM staff_notifications WHERE staff_id = ? AND read_at IS NULL',
      [staffId],
    )

    return ok({
      notifications: rows.map((r: any) => ({
        id:        r.id,
        type:      r.type,
        title:     r.title,
        body:      r.body,
        storeId:   r.store_id ?? null,
        bookingId: r.booking_id ?? null,
        quoteId:   r.quote_id ?? null,
        jobId:     r.job_id ?? null,
        invoiceId: r.invoice_id ?? null,
        readAt:    r.read_at ? new Date(r.read_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      unreadCount: Number(unreadCount),
    })
  } catch (err) {
    return serverError(err)
  }
}
