import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// POST /c/notifications/read-all
//
// Marks every unread notification for the authenticated customer as read.
// Returns the count that flipped so the portal can decrement the badge
// locally without a second round-trip.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const [result] = await db.query<any>(
      `UPDATE notification_events
       SET read_at = NOW()
       WHERE customer_id = ? AND read_at IS NULL`,
      [ctx.customerId],
    )
    return ok({ marked: Number(result.affectedRows ?? 0) })
  } catch (err) {
    return serverError(err)
  }
}
