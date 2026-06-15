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
      `qi.line_type = 'labour'`,
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
          st.id                                                              AS service_type_id,
          COALESCE(st.name, qi.description)                                  AS service_name,
          st.category,
          SUM(qi.quantity)                                                   AS total_sold,
          SUM(qi.quantity * qi.unit_price)                                   AS total_revenue,
          SUM(COALESCE(qi.hours, 0))                                         AS total_hours,
          ROUND(SUM(qi.quantity * qi.unit_price) / NULLIF(SUM(qi.quantity), 0), 2) AS avg_price,
          ROUND(SUM(COALESCE(qi.hours, 0)) / NULLIF(SUM(qi.quantity), 0), 2)       AS avg_hours,
          COUNT(DISTINCT q.id)                                               AS quote_count
        FROM quote_items qi
        JOIN quotes q              ON q.id = qi.quote_id
        LEFT JOIN service_types st ON st.id = qi.service_type_id
        WHERE ${whereClause}
        GROUP BY COALESCE(st.id, qi.description)
        ORDER BY total_sold DESC
      `, params),
      db.query<any[]>(`
        SELECT
          DATE_FORMAT(q.approved_at, '%Y-%m')   AS month,
          COALESCE(st.id, 0)                    AS service_type_id,
          COALESCE(st.name, qi.description)     AS service_name,
          SUM(qi.quantity)                      AS qty,
          SUM(qi.quantity * qi.unit_price)      AS revenue
        FROM quote_items qi
        JOIN quotes q              ON q.id = qi.quote_id
        LEFT JOIN service_types st ON st.id = qi.service_type_id
        WHERE ${whereClause}
        GROUP BY month, COALESCE(st.id, qi.description)
        ORDER BY month ASC, qty DESC
      `, params),
    ])

    const summaryRows: any[] = summaryResult[0]
    const monthlyRows: any[] = monthlyResult[0]

    const monthlyByKey = new Map<string, any[]>()
    for (const row of monthlyRows) {
      const key = row.service_type_id === 0 ? `desc:${row.service_name}` : `id:${row.service_type_id}`
      if (!monthlyByKey.has(key)) monthlyByKey.set(key, [])
      monthlyByKey.get(key)!.push({
        month:   row.month,
        qty:     Number(row.qty),
        revenue: Number(row.revenue),
      })
    }

    const services = summaryRows.map((row) => {
      const key = row.service_type_id == null ? `desc:${row.service_name}` : `id:${row.service_type_id}`
      return {
        serviceTypeId: row.service_type_id ?? null,
        serviceName:   row.service_name,
        category:      row.category ?? null,
        totalSold:     Number(row.total_sold),
        totalRevenue:  Number(row.total_revenue),
        totalHours:    Number(row.total_hours),
        avgPrice:      Number(row.avg_price),
        avgHours:      Number(row.avg_hours),
        quoteCount:    Number(row.quote_count),
        monthly:       monthlyByKey.get(key) ?? [],
      }
    })

    return ok({ from: from ?? null, to: to ?? null, services })
  } catch (err) {
    return serverError(err)
  }
}
