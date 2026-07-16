import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, serverError } from '../shared/errors'
import { readFromDataLake } from '../shared/dataLake'

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

    // Expenses live in S3 via s3_event_index — see customer/vehicles/expenses/create.ts:17.
    const [pointers] = await db.query<any[]>(
      `SELECT id, s3_key, event_date FROM s3_event_index
       WHERE vehicle_id = ? AND customer_id = ?
         AND event_type IN ('fuel-fills','expenses')
       ORDER BY event_date DESC, id DESC`,
      [vehicle.id, owner.customer_id],
    )

    const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))

    const toDate = (v: any) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)

    return ok({
      expenses: pointers.map((p: any, i: number) => {
        const d = details[i]
        if (!d) return null
        return {
          id:          p.id,
          date:        d.expenseDate ?? toDate(p.event_date),
          category:    d.category,
          description: d.merchantName
            ? (d.merchantSuburb ? `${d.merchantName}, ${d.merchantSuburb}` : d.merchantName)
            : null,
          amount:      d.amount     != null ? Number(d.amount)     : null,
          odometer:    d.odometerKm != null ? Number(d.odometerKm) : null,
        }
      }).filter((r: any) => r != null),
    })
  } catch (err) {
    return serverError(err)
  }
}
