import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'
import { lookupClaim } from './_claim-token'

const ready = bootstrap()

// GET /public/bookings/claim?token=...
//
// Magic-link handler for the confirmation email URL. Verifies the
// token (SHA-256 hash → guest_booking_claims lookup), loads the
// booking summary, and reports whether the customer already has an
// account (drives whether the frontend prompts them to log in vs.
// set a password).
//
// This endpoint is read-only; the actual "convert to a real account"
// write happens via existing customer_auth signup / password-reset
// flows once the customer's frontend has enough info.

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const token = event.queryStringParameters?.token
  if (!token) return badRequest('token query param is required.')

  try {
    const claim = await lookupClaim(db, token)
    if (!claim) return notFound('Claim')
    if (claim.expired) {
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'EXPIRED', message: 'This claim link has expired.' } }),
      }
    }

    // Load the booking + customer + vehicle + services in one shot.
    const [[row]] = await db.query<any[]>(
      `SELECT b.id, b.booking_ref, b.status,
              b.booking_date,
              TIME_FORMAT(b.booking_time, '%H:%i') AS booking_time,
              b.customer_id, b.vehicle_id,
              s.id AS store_id, s.name AS store_name,
              sbs.label AS slot_label,
              c.first_name, c.last_name, c.email, c.mobile,
              v.year, v.make, v.model, v.series, v.rego, v.rego_state
       FROM bookings b
       JOIN stores s   ON s.id = b.store_id
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles v  ON v.id = b.vehicle_id
       LEFT JOIN store_booking_slots sbs
         ON sbs.store_id = b.store_id
         AND sbs.slot_time = b.booking_time
         AND sbs.is_active = 1
       WHERE b.id = ? LIMIT 1`,
      [claim.bookingId],
    )
    if (!row) return notFound('Booking')

    const [services] = await db.query<any[]>(
      `SELECT st.id, st.name
       FROM booking_services bs
       JOIN service_types st ON st.id = bs.service_type_id
       WHERE bs.booking_id = ?
       ORDER BY bs.sort_order ASC, st.name ASC`,
      [claim.bookingId],
    )

    // Does this email already have a customer_auth row? Drives the
    // frontend UX (log in vs. set password).
    const [[auth]] = await db.query<any[]>(
      `SELECT customer_id FROM customer_auth WHERE customer_id = ? LIMIT 1`,
      [row.customer_id],
    )
    const hasAccount = !!auth

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        // Short cache — claim state changes when the user completes
        // conversion. Keep it tight so the workshop app doesn't show
        // "unclaimed" after a successful claim.
        'Cache-Control': 'private, max-age=30',
      },
      body: JSON.stringify({
        claimed:   !!claim.claimedAt,
        claimedAt: claim.claimedAt,
        expiresAt: claim.expiresAt,
        booking: {
          bookingReference: row.booking_ref,
          bookingId:        Number(row.id),
          status:           row.status,
          date:             row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : String(row.booking_date).slice(0, 10),
          time:             row.booking_time,
          slotLabel:        row.slot_label ?? null,
          store: {
            id:   Number(row.store_id),
            name: row.store_name,
          },
          customer: {
            firstName:  row.first_name,
            lastName:   row.last_name,
            email:      row.email,
            mobile:     row.mobile,
            hasAccount,
          },
          vehicle: {
            year:      Number(row.year),
            make:      row.make,
            model:     row.model,
            series:    row.series ?? null,
            rego:      row.rego,
            regoState: row.rego_state,
          },
          serviceTypes: services.map((s: any) => ({ id: Number(s.id), name: s.name })),
        },
      }),
    }
  } catch (err) {
    return serverError(err)
  }
}
