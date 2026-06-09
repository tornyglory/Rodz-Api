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
    const where: string[] = []
    const params: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store?.trim()) {
        where.push('s.name LIKE ?')
        params.push(`%${store.trim()}%`)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ quotes: [], total: 0, limit, offset })
      where.push(`q.store_id IN (${allowedIds.map(() => '?').join(',')})`)
      params.push(...allowedIds)
    }

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

    const [[{ total }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS total ${QUOTE_FROM} ${whereClause}`,
      params,
    )

    const [rows] = await db.query<any[]>(
      `${QUOTE_SELECT} ${whereClause} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )

    const quoteIds = rows.map((r: any) => r.id)
    const itemsMap = await getQuoteItemsBatch(db, quoteIds)

    return ok({
      quotes: rows.map((r: any) => buildQuote(r, itemsMap.get(r.id) ?? [])),
      total: Number(total),
      limit,
      offset,
    })
  } catch (err) {
    return serverError(err)
  }
}
