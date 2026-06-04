import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildJob, getJobServices, getAllowedStoreIds, JOB_SELECT } from './_helpers'

const ready = bootstrap()

const VALID_STATUSES = ['open', 'in_progress', 'awaiting_parts', 'awaiting_approval', 'completed', 'cancelled']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store, hoistId, date, status } = event.queryStringParameters ?? {}

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
        if (!storeRow) return ok({ jobs: [] })
        where.push('j.store_id = ?')
        params.push(storeRow.id)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ jobs: [] })

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
    } else {
      // Default: today + upcoming, plus any in-flight jobs from past dates
      where.push('(b.booking_date >= CURDATE() OR j.status NOT IN (\'completed\',\'invoiced\',\'cancelled\'))')
    }

    if (status && VALID_STATUSES.includes(status)) {
      where.push('j.status = ?')
      params.push(status)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await db.query<any[]>(
      `${JOB_SELECT} ${whereClause} ORDER BY b.booking_date ASC, j.sort_order ASC, j.id ASC`,
      params,
    )

    const jobIds = rows.map((r: any) => r.id)
    const servicesMap = await getJobServices(db, jobIds)

    return ok({ jobs: rows.map((r: any) => buildJob(r, servicesMap.get(r.id) ?? [])) })
  } catch (err) {
    return serverError(err)
  }
}
