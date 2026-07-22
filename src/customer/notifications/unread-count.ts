import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// GET /c/notifications/unread-count
//
// Small, cheap endpoint the portal polls for the bell-icon badge.
// Backed by idx_customer_read (customer_id, read_at) — no table scan.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT COUNT(*) AS cnt FROM notification_events
       WHERE customer_id = ? AND read_at IS NULL`,
      [ctx.customerId],
    )
    return ok({ unreadCount: Number(row?.cnt ?? 0) })
  } catch (err) {
    return serverError(err)
  }
}
