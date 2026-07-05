import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

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

    const [[veh]] = await db.query<any[]>(
      'SELECT rego, make, model, year FROM vehicles WHERE id = ? LIMIT 1',
      [vehicleId],
    )

    const conditions: string[] = ['vehicle_id = ?', 'customer_id = ?']
    const params: any[]        = [vehicleId, ctx.customerId]

    if (q.from)         { conditions.push('expense_date >= ?'); params.push(q.from) }
    if (q.to)           { conditions.push('expense_date <= ?'); params.push(q.to) }
    if (q.year)         { conditions.push('YEAR(expense_date) = ?'); params.push(Number(q.year)) }
    if (q.businessOnly === 'true') { conditions.push('is_business_expense = 1') }

    const [rows] = await db.query<any[]>(
      `SELECT category, merchant_name, merchant_suburb, merchant_state,
              amount_aud, expense_date, odometer_km,
              fuel_type, fuel_litres, price_per_litre,
              ev_kwh, price_per_kwh,
              is_business_expense, notes
       FROM vehicle_expenses
       WHERE ${conditions.join(' AND ')}
       ORDER BY expense_date ASC, id ASC`,
      params,
    )

    const headers = [
      'Date', 'Category', 'Merchant', 'Suburb', 'State',
      'Amount (AUD)', 'Odometer (km)',
      'Fuel Type', 'Litres', 'Price/Litre',
      'EV kWh', 'Price/kWh',
      'Business Expense', 'Notes',
    ]

    const csvRows = rows.map((r: any) => {
      const date = r.expense_date instanceof Date
        ? r.expense_date.toISOString().slice(0, 10)
        : String(r.expense_date).slice(0, 10)
      return [
        date,
        r.category,
        r.merchant_name,
        r.merchant_suburb,
        r.merchant_state,
        r.amount_aud != null ? Number(r.amount_aud).toFixed(2) : '',
        r.odometer_km != null ? Number(r.odometer_km) : '',
        r.fuel_type,
        r.fuel_litres != null ? Number(r.fuel_litres).toFixed(3) : '',
        r.price_per_litre != null ? Number(r.price_per_litre).toFixed(3) : '',
        r.ev_kwh != null ? Number(r.ev_kwh).toFixed(3) : '',
        r.price_per_kwh != null ? Number(r.price_per_kwh).toFixed(3) : '',
        r.is_business_expense ? 'Yes' : 'No',
        r.notes,
      ].map(csvEscape).join(',')
    })

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
