import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { getCustomerContext } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  getCustomerContext(event)
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id, name, category, description, fixed_price, labour_hours_estimate
       FROM service_types WHERE is_active = 1 ORDER BY sort_order, name`,
    )

    return ok({
      services: rows.map((r: any) => ({
        id:             r.id,
        name:           r.name,
        category:       r.category,
        description:    r.description    ?? null,
        fixedPrice:     r.fixed_price    ? Number(r.fixed_price)           : null,
        estimatedHours: Number(r.labour_hours_estimate),
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
