import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// DELETE /c/vehicles/{id}/modifications/{modId}
//
// Soft delete — the row stays but is hidden from list/detail responses.
// Attached receipts stay in the expense tracker (spend is spend — the
// money left the wallet). Media rows also remain but become orphaned
// from a UI perspective. Undelete would require re-inserting.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const modId     = Number(event.pathParameters?.modId)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    const [result]: any = await db.query(
      `UPDATE vehicle_modifications SET deleted_at = NOW()
       WHERE id = ? AND vehicle_id = ? AND deleted_at IS NULL`,
      [modId, vehicleId],
    )
    if (result.affectedRows === 0) return notFound('Modification')

    return ok({ id: modId, deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
