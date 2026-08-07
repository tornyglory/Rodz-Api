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

// TIME column comes back as "HH:MM:SS"; also handle Date + "HH:MM"
// gracefully. Returns null for the sentinel 00:00:00 (older rows that
// didn't record a specific booking_time).
function toTime(v: any): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toTimeString().slice(0, 5)
  const s = String(v)
  if (s === '00:00:00' || s === '00:00') return null
  if (s.length <= 8 && s.includes(':')) return s.slice(0, 5)
  if (s.length >= 16) return s.slice(11, 16)
  return null
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    // hoists + staff join is 1-to-1 with bookings (both are nullable
    // FKs on the booking row), so no risk of duplicating the row and
    // breaking the services GROUP_CONCAT below.
    // The store_booking_slots join matches on (store_id, slot_time) —
    // slot rows carry a label like "Morning 1" that the customer app
    // can render for context. LEFT JOIN because bookings older than
    // the slot-picker feature have no matching row.
    const [rows] = await db.query<any[]>(
      `SELECT b.id, b.booking_ref, b.booking_date, b.booking_time, b.slot, b.drop_off_type,
              b.customer_notes, b.status, b.cancelled_at,
              s.name AS store_name, s.suburb AS store_suburb, s.phone AS store_phone,
              v.id AS vehicle_id, v.make, v.model, v.year, v.rego,
              h.id AS hoist_id, h.name AS hoist_name,
              staff.id AS tech_id,
              CONCAT(LEFT(staff.first_name, 1), '. ', staff.last_name) AS tech_name,
              sbs.label AS slot_label,
              GROUP_CONCAT(st.name ORDER BY st.name SEPARATOR ', ') AS services
       FROM bookings b
       JOIN stores s ON s.id = b.store_id
       JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN hoists h ON h.id = b.hoist_id
       LEFT JOIN staff staff ON staff.id = COALESCE(b.assigned_staff_id, h.assigned_staff_id)
       LEFT JOIN store_booking_slots sbs
              ON sbs.store_id = b.store_id AND sbs.slot_time = b.booking_time AND sbs.is_active = 1
       LEFT JOIN booking_services bs ON bs.booking_id = b.id
       LEFT JOIN service_types st ON st.id = bs.service_type_id
       WHERE b.customer_id = ? AND b.cancelled_at IS NULL
       GROUP BY b.id, b.booking_ref, b.booking_date, b.booking_time, b.slot, b.drop_off_type,
                b.customer_notes, b.status, b.cancelled_at,
                s.name, s.suburb, s.phone, v.id, v.make, v.model, v.year, v.rego,
                h.id, h.name, staff.id, staff.first_name, staff.last_name, sbs.label
       ORDER BY b.booking_date DESC
       LIMIT 50`,
      [ctx.customerId],
    )

    return ok({
      bookings: rows.map((r: any) => ({
        id:          r.id,
        bookingRef:  r.booking_ref,
        date:        toDate(r.booking_date),
        time:        toTime(r.booking_time),
        slot:        r.slot,
        slotLabel:   r.slot_label ?? null,
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
        hoist:    r.hoist_id ? { id: Number(r.hoist_id), name: r.hoist_name } : null,
        tech:     r.tech_id  ? { id: Number(r.tech_id),  name: r.tech_name  } : null,
        services: r.services ?? null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
