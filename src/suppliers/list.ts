import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { buildSupplier, SUPPLIER_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { search } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['is_active = 1']
    const params: unknown[] = []

    if (search?.trim()) {
      where.push('name LIKE ?')
      params.push(`%${search.trim()}%`)
    }

    const [rows] = await db.query<any[]>(
      `${SUPPLIER_SELECT} WHERE ${where.join(' AND ')} ORDER BY name ASC`,
      params,
    )

    return ok({ suppliers: rows.map(buildSupplier) })
  } catch (err) {
    return serverError(err)
  }
}
