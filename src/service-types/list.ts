import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { buildServiceType, SERVICE_TYPE_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { category } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['is_active = 1']
    const params: unknown[] = []

    if (category) {
      where.push('category = ?')
      params.push(category)
    }

    const [rows] = await db.query<any[]>(
      `${SERVICE_TYPE_SELECT} WHERE ${where.join(' AND ')} ORDER BY category, sort_order, name`,
      params,
    )

    return ok({ serviceTypes: rows.map(buildServiceType) })
  } catch (err) {
    return serverError(err)
  }
}
