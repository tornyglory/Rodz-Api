import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { buildPart, PART_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { supplierId, category, search } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['p.is_active = 1']
    const params: unknown[] = []

    if (supplierId) {
      where.push('p.supplier_id = ?')
      params.push(Number(supplierId))
    }

    if (category?.trim()) {
      where.push('p.category = ?')
      params.push(category.trim())
    }

    if (search?.trim()) {
      where.push('(p.name LIKE ? OR p.part_number LIKE ? OR p.supplier_part_number LIKE ?)')
      const term = `%${search.trim()}%`
      params.push(term, term, term)
    }

    const [rows] = await db.query<any[]>(
      `${PART_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.name ASC`,
      params,
    )

    return ok({ parts: rows.map(buildPart) })
  } catch (err) {
    return serverError(err)
  }
}
