import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildPartName } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, category } = body

    const updates: [string, unknown][] = []
    if (name !== undefined)     updates.push(['name', name])
    if (category !== undefined) updates.push(['category', category])

    if (updates.length === 0) return validationError('At least one field is required.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(
      `UPDATE part_names SET ${set} WHERE id = ? AND is_active = 1`,
      values,
    )
    if (result.affectedRows === 0) return notFound('Part name')

    const [[row]] = await db.query<any[]>(
      'SELECT id, name, category FROM part_names WHERE id = ? LIMIT 1',
      [id],
    )

    return ok({ partName: buildPartName(row) })
  } catch (err) {
    return serverError(err)
  }
}
