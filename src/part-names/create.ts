import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildPartName } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, category } = body

    if (!name) return validationError('name is required.')

    const [result] = await db.query<any>(
      'INSERT INTO part_names (name, category, is_active) VALUES (?, ?, 1)',
      [name, category ?? null],
    )

    const [[row]] = await db.query<any[]>(
      'SELECT id, name, category FROM part_names WHERE id = ? LIMIT 1',
      [result.insertId],
    )

    return created({ partName: buildPartName(row) })
  } catch (err) {
    return serverError(err)
  }
}
