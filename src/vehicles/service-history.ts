import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'
import { getInvoiceItems } from '../invoices/_helpers'

const ready = bootstrap()
const PAGE_SIZE = 25
const FRONTEND_URL = process.env.FRONTEND_URL ?? ''

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db   = getPool()
  getAuthContext(event) // validates JWT
  const rego = event.pathParameters?.rego?.toUpperCase()
  const qs   = event.queryStringParameters ?? {}

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT rego,
              CONCAT(ANY_VALUE(year), ' ', ANY_VALUE(make), ' ', ANY_VALUE(model)) AS label,
              ANY_VALUE(odometer_current) AS odometer_current
       FROM vehicles WHERE rego = ? AND is_active = 1 GROUP BY rego LIMIT 1`,
      [rego],
    )
    if (!vehicle) return notFound('Vehicle')

    const conditions: string[] = ['vsl.vehicle_rego = ?']
    const params: any[]        = [rego]

    if (qs.beforeOdometer) {
      conditions.push('(vsl.odometer < ? OR vsl.odometer IS NULL)')
      params.push(Number(qs.beforeOdometer))
    }

    const limit = Math.min(Number(qs.limit) || PAGE_SIZE, 100)

    const [rows] = await db.query<any[]>(`
      SELECT vsl.id, vsl.invoice_id, vsl.invoice_number, vsl.service_date,
             vsl.odometer, vsl.store, vsl.tech, vsl.total, vsl.status, vsl.ai_summary,
             i.token
      FROM vehicle_service_log vsl
      JOIN invoices i ON i.id = vsl.invoice_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(vsl.odometer, 0) DESC, vsl.service_date DESC
      LIMIT ?
    `, [...params, limit + 1])

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    const invoiceIds = rows.map((r: any) => r.invoice_id)
    const itemsMap   = invoiceIds.length ? await getInvoiceItems(db, invoiceIds) : new Map()

    const [[totals]] = await db.query<any[]>(
      `SELECT COALESCE(SUM(total), 0) AS lifetime
       FROM vehicle_service_log WHERE vehicle_rego = ? AND status IN ('sent', 'paid')`,
      [rego],
    )

    const toDate = (v: any) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

    const history = rows.map((r: any) => {
      const items  = itemsMap.get(r.invoice_id) ?? []
      const photos = items.flatMap((item: any) => item.photos ?? [])

      return {
        invoiceId:     r.invoice_id,
        invoiceNumber: r.invoice_number,
        invoiceUrl:    r.token ? `${FRONTEND_URL}/invoice/${r.token}` : null,
        serviceDate:   toDate(r.service_date),
        odometer:      r.odometer ?? null,
        store:         r.store    ?? null,
        tech:          r.tech     ?? null,
        total:         Number(r.total),
        status:        r.status,
        aiSummary:     r.ai_summary ?? null,
        items: items.map((item: any) => ({
          description: item.description,
          type:        item.type,
          qty:         item.qty,
          unitPrice:   item.unitPrice,
        })),
        photos,
      }
    })

    const lastRow = rows[rows.length - 1]

    return ok({
      vehicle: {
        rego:            vehicle.rego,
        label:           vehicle.label   ?? null,
        odometerCurrent: vehicle.odometer_current ?? null,
      },
      lifetimeTotal: Number(totals?.lifetime ?? 0),
      history,
      hasMore,
      nextCursor: hasMore && lastRow?.odometer ? lastRow.odometer : null,
    })
  } catch (err) {
    return serverError(err)
  }
}
