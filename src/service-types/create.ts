import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildServiceType, SERVICE_TYPE_SELECT, VALID_CATEGORIES, VALID_COMPLEXITIES } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const {
      name, category, complexity, description,
      labourHoursEstimate, labourRate, hoistRequired, tyreBayJob,
      fixedPrice, defaultIntervalKm, defaultIntervalMonths, sortOrder,
    } = body

    if (!name)                      return validationError('name is required.')
    if (!category)                  return validationError('category is required.')
    if (!complexity)                return validationError('complexity is required.')
    if (labourHoursEstimate == null) return validationError('labourHoursEstimate is required.')
    if (labourRate == null)         return validationError('labourRate is required.')

    if (!VALID_CATEGORIES.includes(category)) {
      return validationError(`category must be one of: ${VALID_CATEGORIES.join(', ')}.`)
    }
    if (!VALID_COMPLEXITIES.includes(complexity)) {
      return validationError(`complexity must be one of: ${VALID_COMPLEXITIES.join(', ')}.`)
    }

    const [result] = await db.query<any>(
      `INSERT INTO service_types
         (name, category, complexity, description, labour_hours_estimate, labour_rate,
          hoist_required, tyre_bay_job, fixed_price, default_interval_km,
          default_interval_months, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        name, category, complexity, description ?? null,
        labourHoursEstimate, labourRate,
        hoistRequired ? 1 : 0, tyreBayJob ? 1 : 0,
        fixedPrice ?? null, defaultIntervalKm ?? null,
        defaultIntervalMonths ?? null, sortOrder ?? 0,
      ],
    )

    const [[row]] = await db.query<any[]>(
      `${SERVICE_TYPE_SELECT} WHERE id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ serviceType: buildServiceType(row) })
  } catch (err) {
    return serverError(err)
  }
}
