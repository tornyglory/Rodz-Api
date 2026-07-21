import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, loadMediaForMod, shapeModification } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{id}/modifications/{modId}
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const modId     = Number(event.pathParameters?.modId)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    const [[row]] = await db.query<any[]>(
      `SELECT id, vehicle_id, category, name, brand, description, installed_at, installed_by,
              cost_aud, status, removed_at, kept_with_sale, is_public, cover_image_id,
              created_at, updated_at
       FROM vehicle_modifications
       WHERE id = ? AND vehicle_id = ? AND deleted_at IS NULL LIMIT 1`,
      [modId, vehicleId],
    )
    if (!row) return notFound('Modification')

    const media = await loadMediaForMod(db, modId)
    return ok({ modification: shapeModification(row, media) })
  } catch (err) {
    return serverError(err)
  }
}
