import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { buildCatalogItem } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { category, search } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['is_active = 1']
    const params: unknown[] = []

    if (category?.trim()) {
      where.push('category = ?')
      params.push(category.trim())
    }

    if (search?.trim()) {
      where.push('name LIKE ?')
      params.push(`%${search.trim()}%`)
    }

    const [rows] = await db.query<any[]>(
      `SELECT id, name, description, category, type, hours, unit_price
       FROM catalog_items
       WHERE ${where.join(' AND ')}
       ORDER BY category ASC, name ASC`,
      params,
    )

    return ok({ items: rows.map(buildCatalogItem) })
  } catch (err) {
    return serverError(err)
  }
}
