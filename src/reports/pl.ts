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
        period: { from, to }, store: scope.label,
        revenue: { labour: 0, parts: 0, other: 0, total: 0 },
        cogs: { partsCost: 0, total: 0 },
        grossProfit: 0, grossMarginPct: 0,
      })
    }

    const ph = scope.ids.map(() => '?').join(',')

    const [revenueRows, cogsRows] = await Promise.all([
      // Revenue ex-GST from invoice line items — use line_total (stored)
      db.query<any[]>(
        `SELECT
           SUM(CASE WHEN ii.type = 'labour' THEN ii.line_total ELSE 0 END) AS labour,
           SUM(CASE WHEN ii.type = 'part'   THEN ii.line_total ELSE 0 END) AS parts,
           SUM(CASE WHEN ii.type = 'other'  THEN ii.line_total ELSE 0 END) AS other,
           SUM(ii.line_total) AS total
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.status IN ('sent', 'paid')
           AND DATE(i.created_at) BETWEEN ? AND ?
           AND i.store_id IN (${ph})`,
        [from, to, ...scope.ids],
      ),
      // COGS from received purchase orders in the period
      db.query<any[]>(
        `SELECT COALESCE(SUM(poi.unit_cost * poi.quantity_ordered), 0) AS parts_cost
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.status = 'received'
           AND DATE(po.received_at) BETWEEN ? AND ?
           AND po.store_id IN (${ph})`,
        [from, to, ...scope.ids],
      ),
    ])

    const [[rev]]  = revenueRows
    const [[cogs]] = cogsRows

    const labour     = Number(Number(rev?.labour    ?? 0).toFixed(2))
    const parts      = Number(Number(rev?.parts     ?? 0).toFixed(2))
    const other      = Number(Number(rev?.other     ?? 0).toFixed(2))
    const revTotal   = Number(Number(rev?.total     ?? 0).toFixed(2))
    const partsCost  = Number(Number(cogs?.parts_cost ?? 0).toFixed(2))
    const grossProfit = Number((revTotal - partsCost).toFixed(2))
    const grossMarginPct = revTotal > 0 ? Math.round((grossProfit / revTotal) * 100) : 0

    return ok({
      period:      { from, to },
      store:       scope.isAll ? null : scope.label,
      revenue:     { labour, parts, other, total: revTotal },
      cogs:        { partsCost, total: partsCost },
      grossProfit,
      grossMarginPct,
    })
  } catch (err) {
    return serverError(err)
  }
}
