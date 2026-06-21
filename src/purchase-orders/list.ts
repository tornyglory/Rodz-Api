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
  const { storeId, status, jobId, search, limit: limitParam, offset: offsetParam } = event.queryStringParameters ?? {}

  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0)

  try {
    // TODO: restore 'po.deleted_at IS NULL' once the deleted_at migration has been run on the DB

    // Store-scoped filter — reused for stats (ignores status/search/jobId)
    const storeConditions: string[] = []
    const storeParams: any[] = []

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      const ids = storeId ? [Number(storeId)].filter((id) => allowedIds.includes(id)) : allowedIds
      if (ids.length === 0) return ok({
        purchaseOrders: [], total: 0, limit, offset,
        stats: { totalPOs: 0, awaitingDelivery: 0, receivedThisMonth: 0, totalSpend: 0 },
      })
      storeConditions.push(`po.store_id IN (${ids.map(() => '?').join(',')})`)
      storeParams.push(...ids)
    } else if (storeId) {
      storeConditions.push('po.store_id = ?')
      storeParams.push(Number(storeId))
    }

    const storeWhere = storeConditions.length ? ` WHERE ${storeConditions.join(' AND ')}` : ''
    const storeAnd  = storeConditions.length ? ` AND` : ` WHERE`

    // Full filter for the paginated list
    const conditions = [...storeConditions]
    const params     = [...storeParams]

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

    const [
      [[{ total }]],
      [rows],
      [[{ totalPOs }]],
      [[{ awaitingDelivery }]],
      [[{ receivedThisMonth }]],
      [[{ totalSpend }]],
    ] = await Promise.all([
      db.query<any[]>(`SELECT COUNT(*) AS total FROM purchase_orders po${where}`, params),
      db.query<any[]>(`${PO_SELECT}${where} ORDER BY po.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      db.query<any[]>(`SELECT COUNT(*) AS totalPOs FROM purchase_orders po${storeWhere}`, storeParams),
      db.query<any[]>(
        `SELECT COUNT(*) AS awaitingDelivery FROM purchase_orders po${storeWhere}${storeAnd} po.status IN ('ordered', 'partial')`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS receivedThisMonth FROM purchase_orders po${storeWhere}${storeAnd}
         po.status = 'received' AND YEAR(po.received_at) = YEAR(NOW()) AND MONTH(po.received_at) = MONTH(NOW())`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COALESCE(SUM(po.total), 0) AS totalSpend FROM purchase_orders po${storeWhere}${storeAnd}
         po.status IN ('ordered', 'partial', 'received')`,
        storeParams,
      ),
    ])

    const poIds = rows.map((r: any) => r.id)
    const itemsMap = await getPOItemsBatch(db, poIds)

    return ok({
      purchaseOrders: rows.map((row: any) => buildPO(row, itemsMap.get(row.id) ?? [])),
      total:  Number(total),
      limit,
      offset,
      stats: {
        totalPOs:          Number(totalPOs),
        awaitingDelivery:  Number(awaitingDelivery),
        receivedThisMonth: Number(receivedThisMonth),
        totalSpend:        Number(Number(totalSpend).toFixed(2)),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
