import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { badRequest, forbidden, ok, serverError } from '../shared/errors'

const ready = bootstrap()

// GET /reports/attribution?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=source
//
// Marketing / operations report — which channels convert, from where,
// on what devices. All dimensions come from bookings.utm_* and the
// bookings.submission_context JSON blob captured on guest-form
// submits. `submission_context.country/city/device.type` only populate
// when the Cloudflare worker fronts the API (frontend + geo dimensions
// are null until then; the endpoint still works, results are just
// sparse).
//
// Auth: staff JWT (same authorizer as the admin catalog). technician
// role forbidden (read-only report is fine for store_manager +).

const VALID_GROUP_BY = new Set(['source', 'medium', 'campaign', 'country', 'city', 'region', 'device'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Statuses that map to "actually served the customer" vs "didn't
// happen". Pending sits in the middle — the customer submitted but
// staff hasn't decided yet. conversionRate excludes pending so it
// reflects staff-decided outcomes only.
const CONFIRMED_STATUSES = ['confirmed', 'in_progress', 'completed']
const REJECTED_STATUSES  = ['cancelled', 'rejected', 'no_show']

// Column expressions for each groupBy dimension. Extracted so the
// SELECT + GROUP BY + ORDER BY use exactly the same expression.
// NULLIF folds MySQL's "JSON null unquoted" result — the literal
// string 'null' — into a real SQL NULL. Otherwise a submission with
// {"country": null} bucket-splits from bookings that have no context.
const jsonScalar = (path: string) =>
  `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(b.submission_context, '${path}')), 'null')`

const GROUP_EXPR: Record<string, string> = {
  source:   'b.utm_source',
  medium:   'b.utm_medium',
  campaign: 'b.utm_campaign',
  country:  jsonScalar('$.country'),
  city:     jsonScalar('$.city'),
  region:   jsonScalar('$.region'),
  device:   jsonScalar('$.device.type'),
}

function firstOfCurrentMonthISO(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function conversionRate(confirmed: number, rejected: number): number | null {
  const denom = confirmed + rejected
  return denom === 0 ? null : Number((confirmed / denom).toFixed(4))
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role === 'technician') return forbidden()

  const qs = event.queryStringParameters ?? {}
  const from    = qs.from    ?? firstOfCurrentMonthISO()
  const to      = qs.to      ?? todayISO()
  const groupBy = (qs.groupBy ?? 'source').toLowerCase()

  if (!ISO_DATE.test(from)) return badRequest('from must be a YYYY-MM-DD date.')
  if (!ISO_DATE.test(to))   return badRequest('to must be a YYYY-MM-DD date.')
  if (from > to)            return badRequest('from must be <= to.')
  if (!VALID_GROUP_BY.has(groupBy)) {
    return badRequest(`groupBy must be one of: ${[...VALID_GROUP_BY].join(', ')}.`)
  }

  const confirmedList = CONFIRMED_STATUSES.map(() => '?').join(',')
  const rejectedList  = REJECTED_STATUSES.map(() => '?').join(',')

  const baseWhere = `b.booking_date BETWEEN ? AND ? AND b.cancelled_at IS NULL`
  const groupExpr = GROUP_EXPR[groupBy]

  try {
    // ── Totals across the whole date range ─────────────────────────────
    const [[tot]] = await db.query<any[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN b.status IN (${confirmedList}) THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN b.status IN (${rejectedList})  THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END)           AS pending
       FROM bookings b
       WHERE ${baseWhere}`,
      [...CONFIRMED_STATUSES, ...REJECTED_STATUSES, from, to],
    )

    // ── Grouped breakdown ──────────────────────────────────────────────
    const [rows] = await db.query<any[]>(
      `SELECT
         ${groupExpr} AS \`key\`,
         COUNT(*) AS bookings,
         SUM(CASE WHEN b.status IN (${confirmedList}) THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN b.status IN (${rejectedList})  THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM bookings b
       WHERE ${baseWhere}
       GROUP BY ${groupExpr}
       ORDER BY bookings DESC, \`key\` ASC`,
      [...CONFIRMED_STATUSES, ...REJECTED_STATUSES, from, to],
    )

    const breakdown = rows.map((r: any) => {
      const confirmed = Number(r.confirmed ?? 0)
      const rejected  = Number(r.rejected  ?? 0)
      return {
        key:            r.key === null || r.key === undefined ? null : String(r.key),
        bookings:       Number(r.bookings),
        confirmed,
        rejected,
        pending:        Number(r.pending ?? 0),
        conversionRate: conversionRate(confirmed, rejected),
      }
    })

    const totalConfirmed = Number(tot?.confirmed ?? 0)
    const totalRejected  = Number(tot?.rejected  ?? 0)

    return ok({
      from,
      to,
      groupBy,
      totals: {
        bookings:       Number(tot?.total ?? 0),
        confirmed:      totalConfirmed,
        rejected:       totalRejected,
        pending:        Number(tot?.pending ?? 0),
        conversionRate: conversionRate(totalConfirmed, totalRejected),
      },
      breakdown,
    })
  } catch (err) {
    return serverError(err)
  }
}
