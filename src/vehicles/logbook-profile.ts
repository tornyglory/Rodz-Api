import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'
import { loadProfileForVehicle, shapeProfile } from '../shared/vehicleProfile'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.make, v.model, v.year
       FROM vehicles v
       WHERE v.logbook_token = ? AND v.is_active = 1
       LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')

    const { base, override } = await loadProfileForVehicle(db, vehicle)
    if (!base) return notFound('Profile')

    return ok(shapeProfile(vehicle, base, override))
  } catch (err) {
    return serverError(err)
  }
}
