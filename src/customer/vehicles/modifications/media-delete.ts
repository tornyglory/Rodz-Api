import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { refreshVehicleSummaries } from '../../../shared/summaries'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// DELETE /c/vehicles/{id}/modifications/{modId}/media/{mediaId}
//
// Hard-delete: media row goes, and if it was a receipt with a linked
// expense entry, that s3_event_index pointer is deleted too so the
// expense tracker stays consistent. (The S3 blob itself is left as
// tombstone data — cheap and lifecycle-managed by the bucket.)
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const modId     = Number(event.pathParameters?.modId)
  const mediaId   = Number(event.pathParameters?.mediaId)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    const [[row]] = await db.query<any[]>(
      `SELECT vmm.id, vmm.expense_event_id
       FROM vehicle_modification_media vmm
       JOIN vehicle_modifications vm ON vm.id = vmm.modification_id
       WHERE vmm.id = ? AND vmm.modification_id = ? AND vm.vehicle_id = ? LIMIT 1`,
      [mediaId, modId, vehicleId],
    )
    if (!row) return notFound('Media')

    if (row.expense_event_id) {
      await db.query('DELETE FROM s3_event_index WHERE id = ?', [row.expense_event_id])
      await refreshVehicleSummaries(db, vehicleId).catch(() => {})
    }

    await db.query('DELETE FROM vehicle_modification_media WHERE id = ?', [mediaId])

    return ok({ id: mediaId, deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
