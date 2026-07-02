import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext, buildVehicle } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const [rows] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.rego_state, v.rego_expiry, v.vin, v.make, v.model, v.series, v.year,
              v.colour, v.body_type, v.fuel_type, v.transmission, v.drive_type,
              v.engine_code, v.engine_size_cc, v.cylinders, v.tyre_size_front, v.tyre_size_rear,
              v.odometer_current, v.next_service_due_km, v.next_service_due_date,
              v.service_interval_km, v.service_interval_months,
              v.avatar_image_id, v.cover_image_id, v.logbook_token
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [ctx.customerId],
    )

    return ok({ vehicles: rows.map(buildVehicle) })
  } catch (err) {
    return serverError(err)
  }
}
