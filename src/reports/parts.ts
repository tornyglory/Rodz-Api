import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const { from, to, store } = event.queryStringParameters ?? {}

    const where: string[] = [
      `qi.line_type = 'part'`,
      `q.status IN ('approved', 'converted', 'invoiced', 'paid')`,
    ]
    const params: unknown[] = []

    if (store) { where.push('q.store_id = ?');       params.push(Number(store)) }
    if (from)  { where.push('q.approved_at >= ?');   params.push(from) }
    if (to)    { where.push('q.approved_at <= ?');   params.push(to + ' 23:59:59') }

    const whereClause = where.join(' AND ')

    const [summaryResult, monthlyResult] = await Promise.all([
      db.query<any[]>(`
        SELECT
          p.id                                                            AS part_id,
          COALESCE(p.name, qi.description)                               AS part_name,
          p.part_number,
          sup.name                                                        AS supplier_name,
          p.supplier_id,
          SUM(qi.quantity)                                               AS total_qty,
          SUM(qi.quantity * qi.unit_price)                               AS total_revenue,
          SUM(qi.quantity * p.cost_price)                                AS total_cost,
          SUM(qi.quantity * qi.unit_price) - SUM(qi.quantity * p.cost_price) AS gross_profit,
          ROUND(
            (SUM(qi.quantity * qi.unit_price) - SUM(qi.quantity * p.cost_price))
            / NULLIF(SUM(qi.quantity * qi.unit_price), 0) * 100, 1
          )                                                              AS margin_pct,
          COUNT(DISTINCT q.id)                                           AS quote_count
        FROM quote_items qi
        JOIN quotes q        ON q.id = qi.quote_id
        LEFT JOIN parts p         ON p.id = qi.part_id
        LEFT JOIN suppliers sup   ON sup.id = p.supplier_id
        WHERE ${whereClause}
        GROUP BY COALESCE(p.id, qi.description)
        ORDER BY total_qty DESC
      `, params),
      db.query<any[]>(`
        SELECT
          DATE_FORMAT(q.approved_at, '%Y-%m')   AS month,
          COALESCE(p.id, 0)                     AS part_id,
          COALESCE(p.name, qi.description)      AS part_name,
          SUM(qi.quantity)                      AS qty,
          SUM(qi.quantity * qi.unit_price)      AS revenue
        FROM quote_items qi
        JOIN quotes q    ON q.id = qi.quote_id
        LEFT JOIN parts p ON p.id = qi.part_id
        WHERE ${whereClause}
        GROUP BY month, COALESCE(p.id, qi.description)
        ORDER BY month ASC, qty DESC
      `, params),
    ])

    const summaryRows: any[] = summaryResult[0]
    const monthlyRows: any[] = monthlyResult[0]

    const monthlyByKey = new Map<string, any[]>()
    for (const row of monthlyRows) {
      const key = row.part_id === 0 ? `desc:${row.part_name}` : `id:${row.part_id}`
      if (!monthlyByKey.has(key)) monthlyByKey.set(key, [])
      monthlyByKey.get(key)!.push({
        month:   row.month,
        qty:     Number(row.qty),
        revenue: Number(row.revenue),
      })
    }

    const parts = summaryRows.map((row) => {
      const key = row.part_id == null ? `desc:${row.part_name}` : `id:${row.part_id}`
      return {
        partId:       row.part_id   ?? null,
        partName:     row.part_name,
        partNumber:   row.part_number   ?? null,
        supplier:     row.supplier_name ?? null,
        supplierId:   row.supplier_id   ?? null,
        totalQty:     Number(row.total_qty),
        totalRevenue: Number(row.total_revenue),
        totalCost:    row.total_cost    != null ? Number(row.total_cost)    : null,
        grossProfit:  row.gross_profit  != null ? Number(row.gross_profit)  : null,
        marginPct:    row.margin_pct    != null ? Number(row.margin_pct)    : null,
        quoteCount:   Number(row.quote_count),
        monthly:      monthlyByKey.get(key) ?? [],
      }
    })

    return ok({ from: from ?? null, to: to ?? null, parts })
  } catch (err) {
    return serverError(err)
  }
}
