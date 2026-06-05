import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { QUOTE_SELECT, buildQuote, getAllowedStoreIds, getQuoteItemsBatch } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, status, search } = event.queryStringParameters ?? {}

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
      if (allowedIds.length === 0) return ok({ quotes: [] })
      where.push(`q.store_id IN (${allowedIds.map(() => '?').join(',')})`)
      params.push(...allowedIds)
    }

    if (status?.trim()) {
      where.push('q.status = ?')
      params.push(status.trim())
    }

    if (search?.trim()) {
      const term = `%${search.trim()}%`
      where.push('(CONCAT(c.first_name, \' \', c.last_name) LIKE ? OR v.rego LIKE ? OR q.quote_number LIKE ?)')
      params.push(term, term, term)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await db.query<any[]>(
      `${QUOTE_SELECT} ${whereClause} ORDER BY q.created_at DESC`,
      params,
    )

    const quoteIds = rows.map((r: any) => r.id)
    const itemsMap = await getQuoteItemsBatch(db, quoteIds)

    return ok({
      quotes: rows.map((r: any) => buildQuote(r, itemsMap.get(r.id) ?? [])),
    })
  } catch (err) {
    return serverError(err)
  }
}
