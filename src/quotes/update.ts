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
    const allowed = ['notes', 'status', 'valid_until']
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k))

    if (updates.length === 0) return badRequest('No valid fields to update')

    const set = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(`UPDATE quotes SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return notFound('Quote')

    const [[quote], [items]] = await Promise.all([
      db.query<any[]>('SELECT * FROM quotes WHERE id = ? LIMIT 1', [id]),
      db.query<any[]>('SELECT * FROM quote_line_items WHERE quote_id = ?', [id]),
    ])

    return ok({ ...quote[0], line_items: items })
  } catch (err) {
    return serverError(err)
  }
}
