import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { QUOTE_SELECT, QUOTE_FROM, buildQuote, getAllowedStoreIds, getQuoteItemsBatch } from './_helpers'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, status, search, limit: limitParam, offset: offsetParam } = event.queryStringParameters ?? {}

  const limit = Math.min(Math.max(parseInt(limitParam ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0)

  try {
    // Store-scoped filter — reused for stats (ignores search/status)
    const storeWhere: string[] = []
    const storeParams: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store?.trim()) {
        storeWhere.push('s.name LIKE ?')
        storeParams.push(`%${store.trim()}%`)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({
        quotes: [], total: 0, limit, offset,
        stats: { totalQuotes: 0, pendingApproval: 0, approvedThisMonth: 0, totalValue: 0 },
      })
      storeWhere.push(`q.store_id IN (${allowedIds.map(() => '?').join(',')})`)
      storeParams.push(...allowedIds)
    }

    const storeWhereClause = storeWhere.length > 0 ? `WHERE ${storeWhere.join(' AND ')}` : ''

    // Full filter (store + search + status) for the paginated list
    const where = [...storeWhere]
    const params = [...storeParams]

    if (status?.trim()) {
      where.push('q.status = ?')
      params.push(status.trim())
    }

    if (search?.trim()) {
      const term = `%${search.trim()}%`
      where.push('(CONCAT(c.first_name, \' \', c.last_name) LIKE ? OR v.rego LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR q.quote_number LIKE ?)')
      params.push(term, term, term, term, term)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [
      [[{ total }]],
      [rows],
      [[{ totalQuotes }]],
      [[{ pendingApproval }]],
      [[{ approvedThisMonth }]],
      [[{ totalValue }]],
    ] = await Promise.all([
      db.query<any[]>(`SELECT COUNT(*) AS total ${QUOTE_FROM} ${whereClause}`, params),
      db.query<any[]>(`${QUOTE_SELECT} ${whereClause} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      db.query<any[]>(`SELECT COUNT(*) AS totalQuotes ${QUOTE_FROM} ${storeWhereClause}`, storeParams),
      db.query<any[]>(
        `SELECT COUNT(*) AS pendingApproval ${QUOTE_FROM}
         ${storeWhereClause ? storeWhereClause + ' AND' : 'WHERE'} q.status IN ('sent', 'viewed')`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS approvedThisMonth ${QUOTE_FROM}
         ${storeWhereClause ? storeWhereClause + ' AND' : 'WHERE'}
         q.status IN ('approved', 'converted', 'invoiced', 'paid')
         AND YEAR(q.approved_at) = YEAR(NOW()) AND MONTH(q.approved_at) = MONTH(NOW())`,
        storeParams,
      ),
      db.query<any[]>(
        `SELECT COALESCE(SUM(q.total), 0) AS totalValue ${QUOTE_FROM}
         ${storeWhereClause ? storeWhereClause + ' AND' : 'WHERE'} q.status NOT IN ('draft', 'expired', 'rejected')`,
        storeParams,
      ),
    ])

    const quoteIds = rows.map((r: any) => r.id)
    const itemsMap = await getQuoteItemsBatch(db, quoteIds)

    return ok({
      quotes: rows.map((r: any) => buildQuote(r, itemsMap.get(r.id) ?? [])),
      total:  Number(total),
      limit,
      offset,
      stats: {
        totalQuotes:      Number(totalQuotes),
        pendingApproval:  Number(pendingApproval),
        approvedThisMonth: Number(approvedThisMonth),
        totalValue:       Number(Number(totalValue).toFixed(2)),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
