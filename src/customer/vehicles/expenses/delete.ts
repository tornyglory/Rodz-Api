import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'
import { readFromDataLake, deleteFromDataLake } from '../../../shared/dataLake'
import { refreshVehicleSummaries } from '../../../shared/summaries'

const ready = bootstrap()

// Delete: identifies the expense by s3_event_index.id, removes the S3 object,
// drops the index row, deletes the Cloudflare image if any, and refreshes the
// vehicle's summary aggregates.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const expenseId = Number(event.pathParameters?.expenseId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const [[pointer]] = await db.query<any[]>(
      `SELECT id, s3_key FROM s3_event_index
       WHERE id = ? AND vehicle_id = ? AND customer_id = ?
         AND event_type IN ('fuel-fills','expenses') LIMIT 1`,
      [expenseId, vehicleId, ctx.customerId],
    )
    if (!pointer) return notFound('Expense')

    // Fetch first to know about any attached Cloudflare image.
    const detail = await readFromDataLake<any>(pointer.s3_key)

    await deleteFromDataLake(pointer.s3_key)
    await db.query('DELETE FROM s3_event_index WHERE id = ?', [expenseId])
    await refreshVehicleSummaries(db, vehicleId)

    if (detail?.imageId) {
      await deleteCloudflareImage(detail.imageId).catch(() => {})
    }

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
