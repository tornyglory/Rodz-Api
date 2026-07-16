import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

// invoices.vehicle_rego is denormalised. Match it back to a vehicle the
// customer has ever owned so vehicleId/label are stable even after a
// transfer or vehicle-record rename.
const INVOICE_SELECT = `
  SELECT
    i.id,
    i.invoice_number,
    i.token,
    i.status,
    i.total,
    i.created_at,
    i.paid_at,
    i.due_date,
    i.vehicle_rego,
    v.id    AS vehicle_id,
    v.year  AS vehicle_year,
    v.make  AS vehicle_make,
    v.model AS vehicle_model
  FROM invoices i
  LEFT JOIN (
    SELECT vo.customer_id, veh.rego,
           MIN(veh.id)         AS id,
           ANY_VALUE(veh.year) AS year,
           ANY_VALUE(veh.make) AS make,
           ANY_VALUE(veh.model) AS model
    FROM vehicles veh
    JOIN vehicle_owners vo ON vo.vehicle_id = veh.id
    GROUP BY vo.customer_id, veh.rego
  ) v ON v.customer_id = i.customer_id AND v.rego = i.vehicle_rego
`

// DB status enum is `draft` / `sent` / `paid`. Frontend chips are
// `unpaid` / `paid` / `overdue` / `void`. Overdue is derived from due_date.
// `void` is not currently produced by the pipeline.
function mapStatus(row: any): string {
  const s = row.status as string
  if (s === 'paid') return 'paid'
  if (s === 'sent') {
    if (row.due_date && new Date(row.due_date) < new Date()) return 'overdue'
    return 'unpaid'
  }
  return s // future-proof: pass unknown values through, frontend renders raw
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const qs  = event.queryStringParameters ?? {}

  const limit = Math.min(Math.max(Number(qs.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const beforeId = qs.before ? Number(qs.before) : null

  try {
    const conditions: string[] = [
      'i.customer_id = ?',
      `i.status IN ('sent','paid')`,
    ]
    const params: any[] = [ctx.customerId]

    if (beforeId && Number.isFinite(beforeId)) {
      conditions.push('i.id < ?')
      params.push(beforeId)
    }

    const [rows] = await db.query<any[]>(
      `${INVOICE_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    )

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    const invoices = rows.map((r: any) => ({
      id:           Number(r.id),
      reference:    r.invoice_number,
      token:        r.token ?? null,
      vehicleId:    r.vehicle_id != null ? Number(r.vehicle_id) : null,
      vehicleRego:  r.vehicle_rego,
      vehicleLabel: r.vehicle_year && r.vehicle_make && r.vehicle_model
        ? `${r.vehicle_year} ${r.vehicle_make} ${r.vehicle_model}`
        : null,
      total:        Number(r.total ?? 0),
      status:       mapStatus(r),
      createdAt:    new Date(r.created_at).toISOString(),
      paidAt:       r.paid_at ? new Date(r.paid_at).toISOString() : null,
      dueAt:        r.due_date ? new Date(r.due_date).toISOString() : null,
    }))

    const nextCursor = hasMore && invoices.length ? String(invoices[invoices.length - 1].id) : null

    return ok({ invoices, nextCursor })
  } catch (err) {
    return serverError(err)
  }
}
