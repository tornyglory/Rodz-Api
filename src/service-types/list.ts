import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

function buildServiceType(row: any) {
  return {
    id:                     row.id,
    name:                   row.name,
    category:               row.category,
    description:            row.description ?? null,
    labourHoursEstimate:    Number(row.labour_hours_estimate),
    labourRate:             Number(row.labour_rate),
    complexity:             row.complexity,
    hoistRequired:          row.hoist_required === 1,
    tyreBayJob:             row.tyre_bay_job === 1,
    fixedPrice:             row.fixed_price != null ? Number(row.fixed_price) : null,
    defaultIntervalKm:      row.default_interval_km ?? null,
    defaultIntervalMonths:  row.default_interval_months ?? null,
    sortOrder:              row.sort_order,
  }
}

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
      `SELECT id, name, category, description, labour_hours_estimate, labour_rate,
              complexity, hoist_required, tyre_bay_job, fixed_price,
              default_interval_km, default_interval_months, sort_order
       FROM service_types
       WHERE ${where.join(' AND ')}
       ORDER BY category, sort_order, name`,
      params,
    )

    return ok({ serviceTypes: rows.map(buildServiceType) })
  } catch (err) {
    return serverError(err)
  }
}
