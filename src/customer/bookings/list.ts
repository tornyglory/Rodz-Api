import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

function toDate(v: any): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const [rows] = await db.query<any[]>(
      `SELECT b.id, b.booking_ref, b.booking_date, b.slot, b.drop_off_type,
              b.customer_notes, b.status, b.cancelled_at,
              s.name AS store_name, s.suburb AS store_suburb, s.phone AS store_phone,
              v.id AS vehicle_id, v.make, v.model, v.year, v.rego,
              GROUP_CONCAT(st.name ORDER BY st.name SEPARATOR ', ') AS services
       FROM bookings b
       JOIN stores s ON s.id = b.store_id
       JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN booking_services bs ON bs.booking_id = b.id
       LEFT JOIN service_types st ON st.id = bs.service_type_id
       WHERE b.customer_id = ? AND b.cancelled_at IS NULL
       GROUP BY b.id, b.booking_ref, b.booking_date, b.slot, b.drop_off_type,
                b.customer_notes, b.status, b.cancelled_at,
                s.name, s.suburb, s.phone, v.id, v.make, v.model, v.year, v.rego
       ORDER BY b.booking_date DESC
       LIMIT 50`,
      [ctx.customerId],
    )

    return ok({
      bookings: rows.map((r: any) => ({
        id:          r.id,
        bookingRef:  r.booking_ref,
        date:        toDate(r.booking_date),
        slot:        r.slot,
        type:        r.drop_off_type,
        status:      r.status,
        notes:       r.customer_notes ?? null,
        store: {
          name:   r.store_name,
          suburb: r.store_suburb,
          phone:  r.store_phone ?? null,
        },
        vehicle: {
          id:    r.vehicle_id,
          make:  r.make,
          model: r.model,
          year:  r.year,
          rego:  r.rego,
        },
        services: r.services ?? null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
