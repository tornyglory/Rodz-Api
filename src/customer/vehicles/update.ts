import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, forbidden, notFound, serverError } from '../../shared/errors'
import { getCustomerContext, buildVehicle } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { colour, regoExpiry, vin, odometerKm } = body

    if (regoExpiry != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(regoExpiry))) {
      return validationError('regoExpiry must be in YYYY-MM-DD format.')
    }
    if (odometerKm != null && (isNaN(Number(odometerKm)) || Number(odometerKm) < 0)) {
      return validationError('odometerKm must be a non-negative number.')
    }

    const sets: string[] = ['updated_at = NOW()']
    const params: any[]  = []

    if (colour     != null) { sets.push('colour = ?');           params.push(String(colour).trim() || null) }
    if (regoExpiry != null) { sets.push('rego_expiry = ?');      params.push(String(regoExpiry)) }
    if (vin        != null) { sets.push('vin = ?');              params.push(String(vin).trim().toUpperCase() || null) }
    if (odometerKm != null) { sets.push('odometer_current = ?'); params.push(Number(odometerKm)) }

    if (params.length > 0) {
      params.push(vehicleId)
      await db.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`, params)
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, rego, rego_state, rego_expiry, vin, make, model, series, year,
              colour, body_type, fuel_type, transmission, drive_type,
              engine_code, engine_size_cc, cylinders, tyre_size_front, tyre_size_rear,
              odometer_current, next_service_due_km, next_service_due_date,
              service_interval_km, service_interval_months,
              avatar_image_id, cover_image_id, logbook_token
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!row) return notFound('Vehicle')

    return ok(buildVehicle(row))
  } catch (err) {
    return serverError(err)
  }
}
