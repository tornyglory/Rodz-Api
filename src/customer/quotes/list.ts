import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

// DB → API status mapping. Frontend chip states are `awaiting_approval`,
// `approved`, `partially_approved`, `declined`, `expired`. The DB carries
// finer-grained states (`sent`, `viewed`, `converted`, `invoiced`, `paid`,
// `rejected`) that all collapse into those five buckets.
function mapStatus(row: any): string {
  const s = row.status as string
  if (s === 'sent' || s === 'viewed')  return 'awaiting_approval'
  if (s === 'expired')                 return 'expired'
  if (s === 'rejected')                return 'declined'
  // approved / converted / invoiced / paid — inspect item-level decisions.
  const hasAccepted = Number(row.has_accepted_items) > 0
  const hasDeclined = Number(row.has_declined_items) > 0
  if (hasAccepted && hasDeclined) return 'partially_approved'
  if (!hasAccepted && hasDeclined) return 'declined'
  return 'approved'
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
      'q.customer_id = ?',
      `q.status IN ('sent','viewed','approved','rejected','expired','converted','invoiced','paid')`,
    ]
    const params: any[] = [ctx.customerId]

    if (beforeId && Number.isFinite(beforeId)) {
      conditions.push('q.id < ?')
      params.push(beforeId)
    }

    const [rows] = await db.query<any[]>(
      `SELECT
         q.id,
         q.quote_number,
         q.token,
         q.vehicle_id,
         q.status,
         q.total,
         q.created_at,
         q.approved_at,
         q.rejected_at,
         v.rego AS vehicle_rego,
         CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
         (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.is_accepted = 1) AS has_accepted_items,
         (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.is_accepted = 0) AS has_declined_items
       FROM quotes q
       JOIN vehicles v ON v.id = q.vehicle_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    )

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    const quotes = rows.map((r: any) => {
      const status = mapStatus(r)
      const decisionAt = status === 'declined'
        ? (r.rejected_at ?? r.approved_at)
        : (status === 'approved' || status === 'partially_approved') ? r.approved_at : null

      return {
        id:           Number(r.id),
        reference:    r.quote_number,
        token:        r.token ?? null,
        vehicleId:    Number(r.vehicle_id),
        vehicleRego:  r.vehicle_rego,
        vehicleLabel: r.vehicle_label,
        total:        Number(r.total ?? 0),
        status,
        createdAt:    new Date(r.created_at).toISOString(),
        approvedAt:   decisionAt ? new Date(decisionAt).toISOString() : null,
      }
    })

    const nextCursor = hasMore && quotes.length ? String(quotes[quotes.length - 1].id) : null

    return ok({ quotes, nextCursor })
  } catch (err) {
    return serverError(err)
  }
}
