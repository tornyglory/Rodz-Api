import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildServiceType, SERVICE_TYPE_SELECT, VALID_CATEGORIES, VALID_COMPLEXITIES } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const {
      name, category, complexity, description,
      labourHoursEstimate, labourRate, hoistRequired, tyreBayJob,
      fixedPrice, defaultIntervalKm, defaultIntervalMonths, sortOrder,
    } = body

    if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
      return validationError(`category must be one of: ${VALID_CATEGORIES.join(', ')}.`)
    }
    if (complexity !== undefined && !VALID_COMPLEXITIES.includes(complexity)) {
      return validationError(`complexity must be one of: ${VALID_COMPLEXITIES.join(', ')}.`)
    }

    const updates: [string, unknown][] = []
    if (name !== undefined)                 updates.push(['name', name])
    if (category !== undefined)             updates.push(['category', category])
    if (complexity !== undefined)           updates.push(['complexity', complexity])
    if (description !== undefined)          updates.push(['description', description])
    if (labourHoursEstimate !== undefined)  updates.push(['labour_hours_estimate', labourHoursEstimate])
    if (labourRate !== undefined)           updates.push(['labour_rate', labourRate])
    if (hoistRequired !== undefined)        updates.push(['hoist_required', hoistRequired ? 1 : 0])
    if (tyreBayJob !== undefined)           updates.push(['tyre_bay_job', tyreBayJob ? 1 : 0])
    if (fixedPrice !== undefined)           updates.push(['fixed_price', fixedPrice])
    if (defaultIntervalKm !== undefined)    updates.push(['default_interval_km', defaultIntervalKm])
    if (defaultIntervalMonths !== undefined) updates.push(['default_interval_months', defaultIntervalMonths])
    if (sortOrder !== undefined)            updates.push(['sort_order', sortOrder])

    if (updates.length === 0) return validationError('At least one field is required.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(
      `UPDATE service_types SET ${set} WHERE id = ? AND is_active = 1`,
      values,
    )
    if (result.affectedRows === 0) return notFound('Service type')

    const [[row]] = await db.query<any[]>(
      `${SERVICE_TYPE_SELECT} WHERE id = ? LIMIT 1`,
      [id],
    )

    return ok({ serviceType: buildServiceType(row) })
  } catch (err) {
    return serverError(err)
  }
}
