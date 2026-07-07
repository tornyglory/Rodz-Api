import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, is_active FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    // Get customer_id from current owner to scope expenses correctly
    const [[owner]] = await db.query<any[]>(
      'SELECT customer_id FROM vehicle_owners WHERE vehicle_id = ? AND is_current = 1 LIMIT 1',
      [vehicle.id],
    )

    if (!owner) return ok({ expenses: [] })

    const [rows] = await db.query<any[]>(
      `SELECT id, expense_date, category, merchant_name, merchant_suburb, amount_aud, odometer_km
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ?
       ORDER BY expense_date DESC, id DESC`,
      [vehicle.id, owner.customer_id],
    )

    const toDate = (v: any) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

    return ok({
      expenses: rows.map((r: any) => ({
        id:          r.id,
        date:        toDate(r.expense_date),
        category:    r.category,
        description: r.merchant_name
          ? (r.merchant_suburb ? `${r.merchant_name}, ${r.merchant_suburb}` : r.merchant_name)
          : null,
        amount:      r.amount_aud != null ? Number(r.amount_aud) : null,
        odometer:    r.odometer_km != null ? Number(r.odometer_km) : null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
