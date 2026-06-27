import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { resolveStoreScope } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const qs   = event.queryStringParameters ?? {}
  const from = qs.from
  const to   = qs.to

  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return validationError('from and to are required (YYYY-MM-DD).')
  }
  if (from > to) return validationError('from must be before or equal to to.')

  try {
    const scope = await resolveStoreScope(db, ctx.role, ctx.staffId, ctx.storeId, qs.store)
    if (scope.ids.length === 0) {
      return ok({
        period: { from, to }, store: null,
        collected: 0, credits: 0, netPayable: 0,
        invoiceCount: 0, poCount: 0,
      })
    }

    const ph = scope.ids.map(() => '?').join(',')

    const [collectedRows, creditsRows] = await Promise.all([
      // GST collected — use stored gst column on invoices
      db.query<any[]>(
        `SELECT
           COALESCE(SUM(i.gst), 0) AS collected,
           COUNT(*)                 AS invoice_count
         FROM invoices i
         WHERE i.status IN ('sent', 'paid')
           AND DATE(i.created_at) BETWEEN ? AND ?
           AND i.store_id IN (${ph})`,
        [from, to, ...scope.ids],
      ),
      // GST credits from purchase orders received in the period (10% of cost)
      db.query<any[]>(
        `SELECT
           COALESCE(SUM(poi.unit_cost * poi.quantity_ordered * 0.10), 0) AS credits,
           COUNT(DISTINCT po.id)                                          AS po_count
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.status = 'received'
           AND DATE(po.received_at) BETWEEN ? AND ?
           AND po.store_id IN (${ph})`,
        [from, to, ...scope.ids],
      ),
    ])

    const [[collected]] = collectedRows
    const [[credits]]   = creditsRows

    const collectedAmt = Number(Number(collected?.collected    ?? 0).toFixed(2))
    const creditsAmt   = Number(Number(credits?.credits        ?? 0).toFixed(2))
    const netPayable   = Number((collectedAmt - creditsAmt).toFixed(2))

    return ok({
      period:       { from, to },
      store:        scope.isAll ? null : scope.label,
      collected:    collectedAmt,
      credits:      creditsAmt,
      netPayable,
      invoiceCount: Number(collected?.invoice_count ?? 0),
      poCount:      Number(credits?.po_count        ?? 0),
    })
  } catch (err) {
    return serverError(err)
  }
}
