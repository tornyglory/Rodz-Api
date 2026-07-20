import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { readFromDataLake } from '../../../shared/dataLake'
import { loadWorkshopInvoiceExpenses } from './_workshopInvoices'
import { loadVehiclePolicyExpenses } from './_vehiclePolicies'

const ready = bootstrap()

function csvEscape(val: any): string {
  if (val == null) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const q         = event.queryStringParameters ?? {}

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const [[veh]] = await db.query<any[]>(
      'SELECT rego, make, model, year FROM vehicles WHERE id = ? LIMIT 1',
      [vehicleId],
    )

    // Expenses live in S3 via s3_event_index — see create.ts:17. Filter the
    // pointers by date on the index (indexed columns), then hydrate detail
    // rows from S3. Category/business filters apply after hydration.
    const conditions: string[] = ['vehicle_id = ?', 'customer_id = ?', "event_type IN ('fuel-fills','expenses')"]
    const params: any[]        = [vehicleId, ctx.customerId]

    if (q.from) { conditions.push('event_date >= ?');    params.push(q.from) }
    if (q.to)   { conditions.push('event_date <= ?');    params.push(q.to)   }
    if (q.year) { conditions.push('YEAR(event_date) = ?'); params.push(Number(q.year)) }

    const wantBusinessOnly = q.businessOnly === 'true'

    // Workshop invoices are business-neutral — skip when filtering to business only.
    const workshopFrom = q.from ?? (q.year ? `${Number(q.year)}-01-01` : undefined)
    const workshopTo   = q.to   ?? (q.year ? `${Number(q.year)}-12-31` : undefined)

    const [pointersResult, workshopInvoices, policyExpenses] = await Promise.all([
      db.query<any[]>(
        `SELECT id, s3_key, event_date FROM s3_event_index
         WHERE ${conditions.join(' AND ')}
         ORDER BY event_date ASC, id ASC`,
        params,
      ),
      wantBusinessOnly
        ? Promise.resolve([])
        : loadWorkshopInvoiceExpenses(db, { vehicleId, customerId: ctx.customerId, from: workshopFrom, to: workshopTo }),
      wantBusinessOnly
        ? Promise.resolve([])
        : loadVehiclePolicyExpenses(db, { vehicleId, customerId: ctx.customerId, from: workshopFrom, to: workshopTo }),
    ])

    const [pointers] = pointersResult
    const details    = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))

    const headers = [
      'Date', 'Category', 'Source', 'Merchant', 'Suburb', 'State',
      'Amount (AUD)', 'Odometer (km)',
      'Fuel Type', 'Litres', 'Price/Litre',
      'EV kWh', 'Price/kWh',
      'Business Expense', 'Invoice #', 'Notes',
    ]

    // Collect rows into a shape that carries the date so we can merge-sort
    // user + workshop entries by date before writing CSV.
    const rows: Array<{ date: string; cells: string[] }> = []

    for (let i = 0; i < pointers.length; i++) {
      const p = pointers[i]
      const d = details[i]
      if (!d) continue
      if (wantBusinessOnly && !d.isBusinessExpense) continue

      const date = d.expenseDate
        ?? (p.event_date instanceof Date ? p.event_date.toISOString().slice(0, 10) : String(p.event_date).slice(0, 10))

      rows.push({
        date,
        cells: [
          date,
          d.category,
          'user',
          d.merchantName    ?? '',
          d.merchantSuburb  ?? '',
          d.merchantState   ?? '',
          d.amount          != null ? Number(d.amount).toFixed(2)         : '',
          d.odometerKm      != null ? Number(d.odometerKm)                : '',
          d.fuelType        ?? '',
          d.litres          != null ? Number(d.litres).toFixed(3)         : '',
          d.pricePerLitre   != null ? Number(d.pricePerLitre).toFixed(3)  : '',
          d.evKwh           != null ? Number(d.evKwh).toFixed(3)          : '',
          d.pricePerKwh     != null ? Number(d.pricePerKwh).toFixed(3)    : '',
          d.isBusinessExpense ? 'Yes' : 'No',
          '',
          d.notes ?? '',
        ],
      })
    }

    for (const w of workshopInvoices) {
      rows.push({
        date: w.expenseDate,
        cells: [
          w.expenseDate,
          'workshop',
          'workshop',
          w.merchantName,
          w.merchantSuburb ?? '',
          w.merchantState  ?? '',
          w.amountAud.toFixed(2),
          w.odometerKm != null ? String(w.odometerKm) : '',
          '', '', '', '', '',
          'No',
          w.invoiceNumber,
          w.notes ?? '',
        ],
      })
    }

    for (const p of policyExpenses) {
      rows.push({
        date: p.expenseDate,
        cells: [
          p.expenseDate,
          p.category,
          `policy:${p.policyType}`,
          p.merchantName ?? '',
          '',
          '',
          p.amountAud.toFixed(2),
          '',
          '', '', '', '', '',
          'No',
          p.policyNumber ?? '',
          p.notes ?? '',
        ],
      })
    }

    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const csvRows = rows.map(r => r.cells.map(csvEscape).join(','))

    const yearLabel = q.year ?? (q.from ? q.from.slice(0, 4) : new Date().getFullYear())
    const filename  = veh
      ? `Expenses-${veh.rego}-${veh.make}-${veh.model}-${yearLabel}.csv`
      : `Expenses-${vehicleId}-${yearLabel}.csv`

    const csv = [headers.join(','), ...csvRows].join('\r\n')

    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: csv,
    }
  } catch (err) {
    return serverError(err)
  }
}
