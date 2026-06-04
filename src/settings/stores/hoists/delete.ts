import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { noContent, forbidden, serverError } from '../../../shared/errors'
import { hoistError, getAllowedStoreIds } from '../../../hoists/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const { storeId, hoistId } = event.pathParameters ?? {}

  try {
    const [[hoist]] = await db.query<any[]>(
      'SELECT id, store_id FROM hoists WHERE id = ? AND store_id = ? AND is_active = 1 LIMIT 1',
      [hoistId, storeId],
    )
    if (!hoist) return hoistError(404, 'HOIST_NOT_FOUND', 'Hoist not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(hoist.store_id)) return forbidden()
    }

    // Block delete if any active jobs exist on this hoist
    const [[{ activeCount }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS activeCount FROM service_jobs WHERE hoist_id = ? AND status NOT IN ('completed','invoiced','cancelled')`,
      [hoistId],
    )
    if (Number(activeCount) > 0) {
      return hoistError(409, 'HOIST_HAS_ACTIVE_JOBS', 'Cannot delete a hoist with active jobs. Complete or cancel all jobs first.')
    }

    await db.query('UPDATE hoists SET is_active = 0 WHERE id = ?', [hoistId])
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
