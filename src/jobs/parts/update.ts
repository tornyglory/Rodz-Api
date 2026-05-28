import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, badRequest, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const partId = event.pathParameters?.partId

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const allowed = ['quantity', 'unit_price', 'description', 'status']
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k))

    if (updates.length === 0) return badRequest('No valid fields to update')

    const set = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), partId]

    const [result] = await db.query<any>(`UPDATE job_parts SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return notFound('Part')

    const [rows] = await db.query<any[]>('SELECT * FROM job_parts WHERE id = ? LIMIT 1', [partId])
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
