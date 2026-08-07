import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'

// GET /reports/parts-margin?from=YYYY-MM-DD&to=YYYY-MM-DD[&storeId=1][&bookingId=42]
//
// Rolls up parts cost (from part_orders) alongside parts + labour
// revenue (from service_job_items). Answers: "how much are we saving
// / making on parts across the last week?"
//
// The service_job_items table doesn't hold any rows yet (invoicing
// flow isn't wired) — the endpoint handles that by returning null on
// revenue metrics rather than fabricating zeros. As soon as invoices
// start landing, the same endpoint surfaces real margin.

const ready = bootstrap()
type Pool = mysql.Pool

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const q = event.queryStringParameters ?? {}
    const from     = parseDate(q.from) ?? isoDaysAgo(30)
    const to       = parseDate(q.to)   ?? isoDaysAgo(0)
    const bookingId = q.bookingId ? Number(q.bookingId) : null
    const storeId   = q.storeId   ? Number(q.storeId)
                                  : (ctx.role === 'super_admin' ? null : Number(ctx.storeId))

    // ── Aggregate per booking ────────────────────────────────────────────
    const bindings: any[] = [from, to]
    let where = "b.created_at BETWEEN ? AND ?"
    if (storeId != null) { where += ' AND b.store_id = ?'; bindings.push(storeId) }
    if (bookingId != null) { where += ' AND b.id = ?';    bindings.push(bookingId) }

    const [rows] = await db.query<any[]>(
      `SELECT
         b.id                                          AS booking_id,
         b.booking_ref                                 AS booking_ref,
         b.store_id                                    AS store_id,
         b.created_at                                  AS booking_created_at,
         v.year, v.make, v.model, v.rego,
         sj.id                                         AS service_job_id,
         sj.status                                     AS job_status,

         -- Parts we paid for (from part_orders)
         COALESCE(po.total_cost_aud,     0)            AS parts_cost_aud,
         COALESCE(po.orders_count,        0)           AS orders_count,

         -- Invoice line-item revenue (service_job_items) — null if none
         ji.parts_revenue                              AS parts_revenue_aud,
         ji.labour_revenue                             AS labour_revenue_aud,
         ji.sublet_revenue                             AS sublet_revenue_aud,
         ji.discount_total                             AS discount_aud,
         ji.line_count                                 AS invoice_line_count

       FROM bookings b
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN service_jobs sj ON sj.booking_id = b.id
       LEFT JOIN (
         SELECT booking_id,
                SUM(total_paid_aud)                    AS total_cost_aud,
                COUNT(*)                               AS orders_count
         FROM part_orders
         WHERE status != 'cancelled'
         GROUP BY booking_id
       ) po ON po.booking_id = b.id
       LEFT JOIN (
         SELECT sj2.booking_id                          AS booking_id,
                SUM(CASE WHEN ji2.line_type = 'part'     THEN ji2.line_total ELSE 0 END) AS parts_revenue,
                SUM(CASE WHEN ji2.line_type = 'labour'   THEN ji2.line_total ELSE 0 END) AS labour_revenue,
                SUM(CASE WHEN ji2.line_type = 'sublet'   THEN ji2.line_total ELSE 0 END) AS sublet_revenue,
                SUM(CASE WHEN ji2.line_type = 'discount' THEN ji2.line_total ELSE 0 END) AS discount_total,
                COUNT(*)                               AS line_count
         FROM service_job_items ji2
         JOIN service_jobs sj2 ON sj2.id = ji2.service_job_id
         GROUP BY sj2.booking_id
       ) ji ON ji.booking_id = b.id
       WHERE ${where}
         AND (po.orders_count > 0 OR ji.line_count > 0)
       ORDER BY b.created_at DESC`,
      bindings,
    )

    const bookings = rows.map(r => {
      const partsCost    = r.parts_cost_aud     != null ? Number(r.parts_cost_aud)     : 0
      const partsRevenue = r.parts_revenue_aud  != null ? Number(r.parts_revenue_aud)  : null
      const labourRev    = r.labour_revenue_aud != null ? Number(r.labour_revenue_aud) : null
      const subletRev    = r.sublet_revenue_aud != null ? Number(r.sublet_revenue_aud) : null
      const discount     = r.discount_aud       != null ? Number(r.discount_aud)       : 0
      const totalRevenue = partsRevenue != null || labourRev != null
        ? (partsRevenue ?? 0) + (labourRev ?? 0) + (subletRev ?? 0) + discount   // discount is negative already
        : null
      const partsMargin  = partsRevenue != null ? round2(partsRevenue - partsCost) : null
      const totalMargin  = totalRevenue != null ? round2(totalRevenue - partsCost) : null
      return {
        bookingId:       Number(r.booking_id),
        bookingRef:      r.booking_ref ?? null,
        storeId:         Number(r.store_id),
        createdAt:       r.booking_created_at ? new Date(r.booking_created_at).toISOString() : null,
        vehicleLabel:    r.year ? `${r.year} ${r.make} ${r.model}` : null,
        rego:            r.rego ?? null,
        serviceJobId:    r.service_job_id != null ? Number(r.service_job_id) : null,
        jobStatus:       r.job_status ?? null,
        ordersCount:     Number(r.orders_count),
        invoiceLineCount: r.invoice_line_count != null ? Number(r.invoice_line_count) : 0,
        partsCostAud:    round2(partsCost),
        partsRevenueAud: partsRevenue != null ? round2(partsRevenue) : null,
        labourRevenueAud: labourRev  != null ? round2(labourRev)     : null,
        subletRevenueAud: subletRev  != null ? round2(subletRev)     : null,
        discountAud:      round2(discount),
        totalRevenueAud:  totalRevenue != null ? round2(totalRevenue) : null,
        partsMarginAud:   partsMargin,
        totalMarginAud:   totalMargin,
        // Handy signal: parts margin as % of parts revenue.
        partsMarginPct:   partsRevenue && partsRevenue > 0
          ? round2((partsRevenue - partsCost) / partsRevenue * 100)
          : null,
      }
    })

    // ── Summary ──────────────────────────────────────────────────────────
    const summary = {
      from,
      to,
      bookings:               bookings.length,
      totalPartsCostAud:      round2(bookings.reduce((a, b) => a + b.partsCostAud,    0)),
      totalPartsRevenueAud:   nullIfAllNull(bookings, 'partsRevenueAud',  round2Sum),
      totalLabourRevenueAud:  nullIfAllNull(bookings, 'labourRevenueAud', round2Sum),
      totalRevenueAud:        nullIfAllNull(bookings, 'totalRevenueAud',  round2Sum),
      totalPartsMarginAud:    nullIfAllNull(bookings, 'partsMarginAud',   round2Sum),
      totalMarginAud:         nullIfAllNull(bookings, 'totalMarginAud',   round2Sum),
      averagePartsMarginPct:  bookings.reduce<{ sum: number; n: number }>(
                                (acc, b) => b.partsMarginPct != null
                                  ? { sum: acc.sum + b.partsMarginPct, n: acc.n + 1 }
                                  : acc,
                                { sum: 0, n: 0 }
                              ).n > 0
        ? round2(
            bookings.filter(b => b.partsMarginPct != null).reduce((a, b) => a + b.partsMarginPct!, 0)
            / bookings.filter(b => b.partsMarginPct != null).length,
          )
        : null,
    }

    return ok({
      summary,
      bookings,
      // Data-quality hint for consumers — helps the frontend render "no
      // invoice data yet" rather than assuming margin is 0.
      invoiceDataAvailable: bookings.some(b => b.invoiceLineCount > 0),
    })
  } catch (err) {
    return serverError(err)
  }
}

function parseDate(s?: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return s
}
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}
function round2(n: number): number { return Math.round(n * 100) / 100 }
function round2Sum(arr: number[]): number { return round2(arr.reduce((a, b) => a + b, 0)) }
function nullIfAllNull<T extends Record<string, any>>(arr: T[], key: keyof T, agg: (vals: number[]) => number): number | null {
  const vals: number[] = []
  for (const x of arr) {
    const v = x[key] as unknown
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
  }
  return vals.length ? agg(vals) : null
}
