import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

const ready = bootstrap()

// Session metadata list. Messages now live in S3 (one blob per session), so
// this endpoint returns titles + timestamps only — the frontend fetches the
// full history via GET /c/vehicles/:id/chats/:sessionId when the user picks
// a session. No S3 GETs here.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT id, title, created_at, updated_at
       FROM customer_chat_sessions
       WHERE vehicle_id = ? AND customer_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [vehicleId, ctx.customerId],
    )

    const sessions = rows.map((r: any) => ({
      id:            r.id,
      title:         r.title ?? null,
      preview:       null,                 // per-session preview would require an S3 GET each; drop for now
      lastMessageAt: r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : r.updated_at ? String(r.updated_at) : null,
      createdAt:     r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    }))

    return ok({ sessions })
  } catch (err) {
    return serverError(err)
  }
}
