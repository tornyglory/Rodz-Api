import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { staffId } = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const [result] = await db.query<any>(
      'UPDATE staff_notifications SET read_at = NOW() WHERE id = ? AND staff_id = ? AND read_at IS NULL',
      [id, staffId],
    )
    if (result.affectedRows === 0) return notFound('Notification')

    const [[row]] = await db.query<any[]>(
      `SELECT id, type, title, body, store_id, booking_id, quote_id, job_id, invoice_id, read_at, created_at
       FROM staff_notifications WHERE id = ? LIMIT 1`,
      [id],
    )
    return ok({
      id:        row.id,
      type:      row.type,
      title:     row.title,
      body:      row.body,
      storeId:   row.store_id ?? null,
      bookingId: row.booking_id ?? null,
      quoteId:   row.quote_id ?? null,
      jobId:     row.job_id ?? null,
      invoiceId: row.invoice_id ?? null,
      readAt:    row.read_at ? new Date(row.read_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    })
  } catch (err) {
    return serverError(err)
  }
}
