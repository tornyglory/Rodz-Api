import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const staffId = event.pathParameters?.id

  try {
    const [[staff]] = await db.query<any[]>(
      'SELECT id FROM staff WHERE id = ? AND is_active = 1 LIMIT 1', [staffId],
    )
    if (!staff) return notFound('Staff member')

    const [rows] = await db.query<any[]>(
      `SELECT id, type, start_date, end_date, days, notes, created_at
       FROM staff_leave WHERE staff_id = ? ORDER BY start_date DESC`,
      [staffId],
    )

    return ok({
      staffId: Number(staffId),
      entries: rows.map((r: any) => ({
        id:        Number(r.id),
        type:      r.type,
        startDate: r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
        endDate:   r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
        days:      Number(r.days),
        notes:     r.notes ?? null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
