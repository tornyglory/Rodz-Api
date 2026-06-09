import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 100

const VALID_JOB_STATUSES = new Set([
  'open', 'in_progress', 'awaiting_parts', 'awaiting_approval',
  'completed', 'invoiced', 'cancelled',
])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { search, store, status, limit: limitParam, offset: offsetParam } = event.queryStringParameters ?? {}

  const limit  = Math.min(Math.max(parseInt(limitParam  ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0)

  try {
    const where:  string[]  = ['v.is_active = 1', 'c.is_active = 1']
    const params: unknown[] = []

    // ── Search ─────────────────────────────────────────────────────────────
    if (search && search.trim()) {
      const term = `%${search.trim().replace(/\s+/g, '')}%`
      const like = `%${search.trim()}%`
      where.push(`(
        REPLACE(v.rego, ' ', '') LIKE ?
        OR v.make  LIKE ?
        OR v.model LIKE ?
        OR CONCAT(v.year, ' ', v.make, ' ', v.model) LIKE ?
      )`)
      params.push(term, like, like, like)
    }

    // ── Store / role scoping ───────────────────────────────────────────────
    if (ctx.role === 'store_manager' || ctx.role === 'technician') {
      where.push('c.store_id = ?')
      params.push(ctx.storeId)
    } else if (store && store !== 'all') {
      where.push('s.name LIKE ?')
      params.push(`%${store}%`)
    }

    // ── Job status filter ──────────────────────────────────────────────────
    const statusValues: string[] = []
    if (status) {
      for (const s of status.split(',')) {
        const v = s.trim()
        if (VALID_JOB_STATUSES.has(v)) statusValues.push(v)
      }
    }

    if (statusValues.length > 0) {
      const ph = statusValues.map(() => '?').join(', ')
      where.push(`EXISTS (
        SELECT 1 FROM service_jobs sj
        WHERE sj.vehicle_id = v.id
          AND sj.status NOT IN ('completed', 'cancelled')
          AND sj.status IN (${ph})
      )`)
      params.push(...statusValues)
    }

    const whereClause = `WHERE ${where.join(' AND ')}`

    // ── Count ──────────────────────────────────────────────────────────────
    const [[{ total }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS total
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       JOIN customers c       ON c.id = vo.customer_id
       JOIN stores s          ON s.id = c.store_id
       ${whereClause}`,
      params,
    )

    // ── Fetch ──────────────────────────────────────────────────────────────
    const [rows] = await db.query<any[]>(
      `SELECT
         v.id,
         v.rego,
         v.year,
         v.make,
         v.model,
         c.id                                     AS customer_id,
         CONCAT(c.first_name, ' ', c.last_name)  AS customer_name,
         c.mobile                                 AS customer_phone,
         c.email                                  AS customer_email,
         s.name                                   AS store_name,
         (
           SELECT DATE(sj.completed_at)
           FROM service_jobs sj
           WHERE sj.vehicle_id = v.id AND sj.completed_at IS NOT NULL
           ORDER BY sj.completed_at DESC
           LIMIT 1
         ) AS last_service,
         (
           SELECT sj.odometer_in
           FROM service_jobs sj
           WHERE sj.vehicle_id = v.id AND sj.completed_at IS NOT NULL
           ORDER BY sj.completed_at DESC
           LIMIT 1
         ) AS last_service_km,
         (
           SELECT sj.status
           FROM service_jobs sj
           WHERE sj.vehicle_id = v.id AND sj.status NOT IN ('completed', 'cancelled')
           ORDER BY sj.created_at DESC
           LIMIT 1
         ) AS active_job_status
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       JOIN customers c       ON c.id = vo.customer_id
       JOIN stores s          ON s.id = c.store_id
       ${whereClause}
       ORDER BY v.rego ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )

    const vehicles = rows.map((row: any) => ({
      id:              row.id,
      rego:            row.rego,
      year:            row.year,
      make:            row.make,
      model:           row.model,
      customerId:      row.customer_id,
      customerName:    row.customer_name,
      customerPhone:   row.customer_phone ?? null,
      customerEmail:   row.customer_email ?? null,
      store:           (row.store_name ?? '').replace(/^Rodz /, ''),
      lastService:     row.last_service
                         ? (row.last_service instanceof Date
                             ? row.last_service.toISOString().slice(0, 10)
                             : String(row.last_service).slice(0, 10))
                         : null,
      lastServiceKm:   row.last_service_km != null ? Number(row.last_service_km) : null,
      activeJobStatus: row.active_job_status ?? null,
    }))

    return ok({ vehicles, total: Number(total), limit, offset })
  } catch (err) {
    return serverError(err)
  }
}
