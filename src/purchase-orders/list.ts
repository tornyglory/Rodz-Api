import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { PO_SELECT, buildPO, getAllowedStoreIds, getPOItemsBatch } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { storeId, status, jobId, search } = event.queryStringParameters ?? {}

  try {
    const conditions: string[] = ['po.deleted_at IS NULL']
    const params: any[] = []

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      const ids = storeId ? [Number(storeId)].filter((id) => allowedIds.includes(id)) : allowedIds
      if (ids.length === 0) return ok({ purchaseOrders: [] })
      conditions.push(`po.store_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    } else if (storeId) {
      conditions.push('po.store_id = ?')
      params.push(Number(storeId))
    }

    if (status) {
      conditions.push('po.status = ?')
      params.push(status)
    }

    if (search) {
      conditions.push('(po.po_number LIKE ? OR po.supplier LIKE ?)')
      params.push(`%${search}%`, `%${search}%`)
    }

    if (jobId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM purchase_order_items poi
        WHERE poi.purchase_order_id = po.id AND poi.service_job_id = ?
      )`)
      params.push(Number(jobId))
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await db.query<any[]>(
      `${PO_SELECT}${where} ORDER BY po.created_at DESC`,
      params,
    )

    const poIds = rows.map((r: any) => r.id)
    const itemsMap = await getPOItemsBatch(db, poIds)

    return ok({
      purchaseOrders: rows.map((row: any) => buildPO(row, itemsMap.get(row.id) ?? [])),
    })
  } catch (err) {
    return serverError(err)
  }
}
