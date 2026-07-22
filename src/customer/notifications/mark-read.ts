import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// POST /c/notifications/{id}/read
//
// Idempotent — re-reading a read notification is a no-op (read_at stays
// at its first-set value). Scoped by customer_id so one customer can't
// mark another's row.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const id  = Number(event.pathParameters?.id)
  if (!id) return validationError('notification id is required.')

  try {
    const [result] = await db.query<any>(
      `UPDATE notification_events
       SET read_at = NOW()
       WHERE id = ? AND customer_id = ? AND read_at IS NULL`,
      [id, ctx.customerId],
    )

    if (result.affectedRows === 0) {
      // Either doesn't exist, belongs to another customer, or already read.
      // Verify existence so we return the right code.
      const [[exists]] = await db.query<any[]>(
        `SELECT 1 AS found FROM notification_events
         WHERE id = ? AND customer_id = ? LIMIT 1`,
        [id, ctx.customerId],
      )
      if (!exists) return notFound('Notification')
      // Already read — still ok.
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
