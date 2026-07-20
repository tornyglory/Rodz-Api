import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { safeDel } from '../../../shared/redis'
import { customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// DELETE /c/vehicles/{id}/policies/{policyId}
// Soft delete — flips deleted_at, releases the (vehicle_id, type) unique
// slot so the customer can create a fresh row of the same type.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const policyId  = Number(event.pathParameters?.policyId)
  if (!vehicleId || !policyId) return notFound('Policy')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const [result] = await db.query<any>(
      `UPDATE vehicle_policies SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [policyId, vehicleId, ctx.customerId],
    )
    if (result.affectedRows === 0) return notFound('Policy')

    await safeDel(`vehicle:${vehicleId}:context`)

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
