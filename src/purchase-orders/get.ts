import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { PO_SELECT, buildPO, getAllowedStoreIds, getPOItems, poError } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(
      // TODO: restore 'AND po.deleted_at IS NULL' once the deleted_at migration has been run
      `${PO_SELECT} WHERE po.id = ? LIMIT 1`,
      [id],
    )
    if (!row) return poError(404, 'NOT_FOUND', 'Purchase order not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return poError(403, 'FORBIDDEN', 'Access denied.')
    }

    const items = await getPOItems(db, row.id)
    return ok({ purchaseOrder: buildPO(row, items) })
  } catch (err) {
    return serverError(err)
  }
}
