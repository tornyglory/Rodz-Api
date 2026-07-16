import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { readFromDataLake } from '../../../shared/dataLake'

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

    const [pointers] = await db.query<any[]>(
      `SELECT id, s3_key, event_date FROM s3_event_index
       WHERE ${conditions.join(' AND ')}
       ORDER BY event_date ASC, id ASC`,
      params,
    )

    const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))
    const wantBusinessOnly = q.businessOnly === 'true'

    const headers = [
      'Date', 'Category', 'Merchant', 'Suburb', 'State',
      'Amount (AUD)', 'Odometer (km)',
      'Fuel Type', 'Litres', 'Price/Litre',
      'EV kWh', 'Price/kWh',
      'Business Expense', 'Notes',
    ]

    const csvRows: string[] = []
    for (let i = 0; i < pointers.length; i++) {
      const p = pointers[i]
      const d = details[i]
      if (!d) continue
      if (wantBusinessOnly && !d.isBusinessExpense) continue

      const date = d.expenseDate
        ?? (p.event_date instanceof Date ? p.event_date.toISOString().slice(0, 10) : String(p.event_date).slice(0, 10))

      csvRows.push([
        date,
        d.category,
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
        d.notes ?? '',
      ].map(csvEscape).join(','))
    }

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
