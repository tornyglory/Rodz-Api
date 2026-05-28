import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, badRequest, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = event.pathParameters?.id

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const allowed = ['status', 'technician_id', 'hoist_id', 'notes', 'started_at', 'completed_at']
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k))

    if (updates.length === 0) return badRequest('No valid fields to update')

    const set = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(`UPDATE jobs SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return notFound('Job')

    const [rows] = await db.query<any[]>('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id])
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
