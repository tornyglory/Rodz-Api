import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { getInvoiceItems } from '../../invoices/_helpers'
import { getCustomerContext } from '../_helpers'
import { imageUrls } from '../../shared/cloudflare'

const ready       = bootstrap()
const FRONTEND_URL = process.env.FRONTEND_URL ?? ''

function toDate(v: any): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    // Verify ownership
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[vehicle]] = await db.query<any[]>(
      `SELECT id, rego, make, model, year, odometer_current, next_service_due_km, next_service_due_date
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!vehicle) return notFound('Vehicle')

    const [rows] = await db.query<any[]>(
      `SELECT vsl.id, vsl.invoice_id, vsl.invoice_number, vsl.service_date,
              COALESCE(i.odometer_in, vsl.odometer) AS odometer,
              vsl.store, vsl.tech, vsl.total, vsl.ai_summary,
              i.status AS invoice_status, i.token AS invoice_token
       FROM vehicle_service_log vsl
       LEFT JOIN invoices i ON i.id = vsl.invoice_id
       WHERE vsl.vehicle_rego = ?
       ORDER BY COALESCE(vsl.odometer, 0) DESC, vsl.service_date DESC`,
      [vehicle.rego],
    )

    const invoiceIds = rows.map((r: any) => r.invoice_id)
    const itemsMap   = invoiceIds.length ? await getInvoiceItems(db, invoiceIds) : new Map()

    const rodzEntries = rows.map((r: any) => {
      const items  = itemsMap.get(r.invoice_id) ?? []
      const photos = items.flatMap((item: any) => item.photos ?? [])

      return {
        id:            `job-${r.invoice_id}`,
        source:        'workshop' as const,
        date:          toDate(r.service_date),
        odometerKm:    r.odometer     ?? null,
        title:         r.ai_summary   ? (r.ai_summary.split('.')[0] ?? r.invoice_number) : r.invoice_number,
        workshop:      r.store        ?? null,
        tech:          r.tech         ?? null,
        cost:          Number(r.total),
        status:        r.invoice_status ?? null,
        invoiceId:     r.invoice_id,
        invoiceNumber: r.invoice_number,
        invoiceUrl:    r.invoice_token ? `${FRONTEND_URL}/invoice/${r.invoice_token}` : null,
        aiSummary:     r.ai_summary    ?? null,
        imageUrl:      null,
        photos,
        lineItems: items.map((item: any) => ({
          type:        item.type,
          description: item.description,
          quantity:    item.qty,
          unitPrice:   item.unitPrice,
        })),
      }
    })

    // Merge in external entries (customer-imported invoices)
    const [extRows] = await db.query<any[]>(
      `SELECT id, image_id, workshop_name, workshop_suburb, service_date,
              odometer_km, services, amount_aud, invoice_number
       FROM vehicle_service_log_external
       WHERE vehicle_id = ? AND customer_id = ?
       ORDER BY service_date DESC, id DESC`,
      [vehicleId, ctx.customerId],
    ).catch(() => [[]] as any)

    const externalEntries = extRows.map((r: any) => ({
      id:            `ext-${r.id}`,
      source:        'external' as const,
      date:          r.service_date ? toDate(r.service_date) : null,
      odometerKm:    r.odometer_km   != null ? Number(r.odometer_km)  : null,
      title:         r.services ? (r.services.split('.')[0] ?? 'Service') : 'Service',
      workshop:      r.workshop_name   ?? null,
      tech:          null,
      cost:          r.amount_aud      != null ? Number(r.amount_aud)  : null,
      status:        null,
      invoiceId:     null,
      invoiceNumber: r.invoice_number  ?? null,
      invoiceUrl:    null,
      aiSummary:     r.services        ?? null,
      imageUrl:      r.image_id ? imageUrls(r.image_id).public : null,
      photos:        [],
      lineItems:     [],
    }))

    // Merge and sort by date descending, Rodz jobs first on same date
    const entries = [...rodzEntries, ...externalEntries].sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      if (b.date !== a.date) return b.date.localeCompare(a.date)
      // Same date: workshop entries first
      if (a.source === 'workshop' && b.source !== 'workshop') return -1
      if (b.source === 'workshop' && a.source !== 'workshop') return 1
      return 0
    })

    return ok({
      vehicle: {
        id:                 vehicle.id,
        rego:               vehicle.rego,
        make:               vehicle.make,
        model:              vehicle.model,
        year:               vehicle.year,
        odometerKm:         vehicle.odometer_current     ? Number(vehicle.odometer_current)     : null,
        nextServiceDueKm:   vehicle.next_service_due_km  ? Number(vehicle.next_service_due_km)  : null,
        nextServiceDueDate: vehicle.next_service_due_date ? toDate(vehicle.next_service_due_date) : null,
      },
      entries,
    })
  } catch (err) {
    return serverError(err)
  }
}
