import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { buildPolicyResponse, customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{id}/policies — active policies attached to a vehicle
// the caller owns. Order: registration → wof → insurance → roadside,
// then by nearest expiry date within each type.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  if (!vehicleId) return notFound('Vehicle')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT id, type, provider, policy_number, cost_aud, effective_from,
              expires_on, phone, notes, image_id, updated_at
       FROM vehicle_policies
       WHERE vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL
       ORDER BY FIELD(type, 'registration', 'wof', 'insurance', 'roadside'),
                expires_on ASC`,
      [vehicleId, ctx.customerId],
    )

    return ok({ policies: rows.map(buildPolicyResponse) })
  } catch (err) {
    return serverError(err)
  }
}
