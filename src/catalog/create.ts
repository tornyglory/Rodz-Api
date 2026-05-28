import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { created, badRequest, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const body = JSON.parse(event.body ?? '{}')
    const { name, sku, category, unit_price, description } = body

    if (!name || !sku) return badRequest('name and sku are required')

    const [result] = await db.query<any>(
      'INSERT INTO catalog (name, sku, category, unit_price, description, active) VALUES (?, ?, ?, ?, ?, 1)',
      [name, sku, category ?? null, unit_price ?? 0, description ?? null],
    )

    const [rows] = await db.query<any[]>('SELECT * FROM catalog WHERE id = ? LIMIT 1', [result.insertId])
    return created(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
