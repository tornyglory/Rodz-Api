import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const entryId   = Number(event.pathParameters?.entryId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[entry]] = await db.query<any[]>(
      'SELECT id, image_id FROM vehicle_service_log_external WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [entryId, vehicleId, ctx.customerId],
    )
    if (!entry) return notFound('Logbook entry')

    await db.query('DELETE FROM vehicle_service_log_external WHERE id = ?', [entryId])

    if (entry.image_id) {
      await deleteCloudflareImage(entry.image_id).catch(() => {})
    }

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
