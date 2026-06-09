import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildJob, getJobServices, getAllowedStoreIds, JOB_SELECT, JOB_FROM } from './_helpers'

const ready = bootstrap()

const VALID_STATUSES = ['open', 'in_progress', 'awaiting_parts', 'awaiting_approval', 'completed', 'cancelled']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, hoistId, date, status, search, limit: limitParam, offset: offsetParam } = event.queryStringParameters ?? {}

  const limit = Math.min(Math.max(parseInt(limitParam ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0)

  try {
    const where: string[] = []
    const params: unknown[] = []

    // ── Store / access control ─────────────────────────────────────────────
    if (ctx.role === 'super_admin') {
      if (store) {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow) return ok({ jobs: [], total: 0, limit, offset })
        where.push('j.store_id = ?')
        params.push(storeRow.id)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ jobs: [], total: 0, limit, offset })

      if (store) {
        const [[storeRow]] = await db.query<any[]>(
          'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
          [`%${store}%`],
        )
        if (!storeRow || !allowedIds.includes(storeRow.id)) return forbidden()
        where.push('j.store_id = ?')
        params.push(storeRow.id)
      } else {
        where.push(`j.store_id IN (${allowedIds.map(() => '?').join(',')})`)
        params.push(...allowedIds)
      }
    }

    // ── Filters ────────────────────────────────────────────────────────────
    if (hoistId) {
      where.push('j.hoist_id = ?')
      params.push(hoistId)
    }

    if (date) {
      where.push('b.booking_date = ?')
      params.push(date)
    } else if (!search) {
      // Default: today + upcoming, plus any in-flight jobs from past dates.
      // Skipped when searching so users can find historical jobs.
      where.push('(b.booking_date >= CURDATE() OR j.status NOT IN (\'completed\',\'invoiced\',\'cancelled\'))')
    }

    if (status && VALID_STATUSES.includes(status)) {
      where.push('j.status = ?')
      params.push(status)
    } else {
      where.push('j.status != ?')
      params.push('cancelled')
    }

    if (search) {
      const term = `%${search}%`
      where.push('(CONCAT(c.first_name, \' \', c.last_name) LIKE ? OR v.rego LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR j.job_number LIKE ?)')
      params.push(term, term, term, term, term)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [[{ total }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS total ${JOB_FROM} ${whereClause}`,
      params,
    )

    const [rows] = await db.query<any[]>(
      `${JOB_SELECT} ${whereClause} ORDER BY b.booking_date ASC, j.sort_order ASC, j.id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )

    const jobIds = rows.map((r: any) => r.id)
    const servicesMap = await getJobServices(db, jobIds)

    return ok({
      jobs: rows.map((r: any) => buildJob(r, servicesMap.get(r.id) ?? [])),
      total: Number(total),
      limit,
      offset,
    })
  } catch (err) {
    return serverError(err)
  }
}
