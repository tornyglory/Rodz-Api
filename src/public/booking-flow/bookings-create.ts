import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, serverError, validationError } from '../../shared/errors'
import { generateBookingRef } from '../../bookings/_helpers'
import { sendBookingReceivedEmail } from '../../shared/emailTemplates'
import { notifyStore } from '../../shared/staffNotifications'
import {
  findActiveSlotByTime, computeSlotAvailability, deriveSlotEnum,
} from '../../shared/bookingSlots'
import { issueClaimToken, buildClaimUrl } from './_claim-token'
import { buildSubmissionContext, type ClientContextInput } from './_submission-context'

const ready = bootstrap()

const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /public/bookings
//
// Guest booking creation for the 11-step flow at
// workshop.rodz.com.au/book. Distinct from POST /book (the older
// one-page website form) — takes structured vehicle data (already
// picked from the catalog by the frontend), a specific (time, hoistId)
// pair the customer chose off the availability endpoint's techs[],
// verifies a Cloudflare Turnstile token, and dedupes repeat submits
// via meta.sessionId.
//
// Payload shape (all nested):
//   customer:      { firstName, lastName, email, mobile }
//   vehicle:       { year, make, model, series?, rego, regoState,
//                    fuelType?, transmission?, avgKmPerWeek? }
//   booking:       { storeId, date, time, hoistId, serviceTypeIds[], customerNotes? }
//   meta:          { sessionId, utmSource?, utmMedium?, utmCampaign?, referer? }
//   turnstileToken: string
//
// Turnstile is verified when TURNSTILE_SECRET env var is set; if not,
// verification is skipped with a console.warn (dev / staging mode).
//
// avgKmPerWeek is accepted in the payload but NOT persisted yet — the
// vehicles.avg_km_per_week column is a deferred migration.

const VALID_STATES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])
const VALID_FUEL   = new Set(['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other'])
const VALID_TRANS  = new Set(['manual', 'automatic', 'cvt', 'dct', 'other'])

interface CustomerInput { firstName?: unknown; lastName?: unknown; email?: unknown; mobile?: unknown }
interface VehicleInput  {
  year?: unknown; make?: unknown; model?: unknown; series?: unknown
  rego?: unknown; regoState?: unknown
  fuelType?: unknown; transmission?: unknown
  avgKmPerWeek?: unknown
}
interface BookingInput  {
  storeId?: unknown; date?: unknown
  time?: unknown; hoistId?: unknown
  serviceTypeIds?: unknown; customerNotes?: unknown
}
interface MetaInput {
  sessionId?: unknown
  utmSource?: unknown; utmMedium?: unknown; utmCampaign?: unknown; referer?: unknown
  context?: ClientContextInput
}

async function verifyTurnstile(token: string, remoteip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET
  if (!secret) {
    console.warn('[bookings-create] TURNSTILE_SECRET not set — skipping bot verification (dev/staging mode).')
    return true
  }
  try {
    const body = new URLSearchParams({ secret, response: token })
    if (remoteip) body.set('remoteip', remoteip)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    })
    const data = await res.json() as { success?: boolean; 'error-codes'?: string[] }
    if (!data.success) {
      console.warn('[bookings-create] Turnstile verification failed:', data['error-codes'])
    }
    return !!data.success
  } catch (err) {
    console.error('[bookings-create] Turnstile fetch failed:', err)
    return false
  }
}

async function fireEnginesAsync(vehicleId: number, customerId: number): Promise<void> {
  const rec = process.env.AI_RECOMMENDATION_FN_ARN
  const veh = process.env.VEHICLE_PROFILE_FN_ARN
  const tasks: Promise<unknown>[] = []
  if (rec) tasks.push(lambdaClient.send(new InvokeCommand({
    FunctionName:   rec,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ vehicleId, customerId })),
  })).catch(err => console.error('recommendation engine invoke failed:', err)))
  if (veh) tasks.push(lambdaClient.send(new InvokeCommand({
    FunctionName:   veh,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ vehicleId })),
  })).catch(err => console.error('vehicle profile engine invoke failed:', err)))
  await Promise.all(tasks)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  let body: {
    customer?: CustomerInput; vehicle?: VehicleInput; booking?: BookingInput
    meta?: MetaInput; turnstileToken?: unknown
  }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return validationError('Body must be valid JSON.')
  }

  const cust  = body.customer ?? {}
  const veh   = body.vehicle  ?? {}
  const bkg   = body.booking  ?? {}
  const meta  = body.meta     ?? {}
  const tsTok = typeof body.turnstileToken === 'string' ? body.turnstileToken : ''

  // ── Validation ──────────────────────────────────────────────────────────
  const firstName = typeof cust.firstName === 'string' ? cust.firstName.trim() : ''
  const lastName  = typeof cust.lastName  === 'string' ? cust.lastName.trim()  : ''
  const email     = typeof cust.email     === 'string' ? cust.email.trim().toLowerCase() : ''
  const mobile    = typeof cust.mobile    === 'string' ? cust.mobile.trim() : ''
  if (!firstName || !lastName || !email || !mobile) {
    return validationError('customer.firstName / lastName / email / mobile are required.')
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return validationError('customer.email must be a valid email address.')
  }

  // Minimum viable vehicle identity for a guest booking:
  //   Required: year, make, rego, regoState
  //   Optional: model, series (workshop fills in on arrival)
  const year  = Number(veh.year)
  const make  = typeof veh.make  === 'string' ? veh.make.trim()  : ''
  const model = typeof veh.model === 'string' && veh.model.trim() ? veh.model.trim() : null
  const rego  = typeof veh.rego  === 'string' ? veh.rego.trim().toUpperCase() : ''
  const regoState = typeof veh.regoState === 'string' ? veh.regoState.trim().toUpperCase() : ''
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return validationError('vehicle.year must be a valid year.')
  }
  if (!make) return validationError('vehicle.make is required.')
  if (!rego) return validationError('vehicle.rego is required.')
  if (!VALID_STATES.has(regoState)) {
    return validationError(`vehicle.regoState must be one of: ${[...VALID_STATES].join(', ')}.`)
  }
  const series       = typeof veh.series       === 'string' ? veh.series.trim() : null
  const fuelType     = typeof veh.fuelType     === 'string' && VALID_FUEL.has(veh.fuelType.toLowerCase())  ? veh.fuelType.toLowerCase()  : null
  const transmission = typeof veh.transmission === 'string' && VALID_TRANS.has(veh.transmission.toLowerCase()) ? veh.transmission.toLowerCase() : null

  const storeId = Number(bkg.storeId)
  const date    = typeof bkg.date === 'string' ? bkg.date : ''
  const time    = typeof bkg.time === 'string' ? bkg.time.trim() : ''
  const hoistId = Number(bkg.hoistId)
  if (!Number.isInteger(storeId) || storeId <= 0) return validationError('booking.storeId is required.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))         return validationError('booking.date must be YYYY-MM-DD.')
  if (!/^\d{2}:\d{2}$/.test(time))               return validationError('time must be in HH:MM format.')
  if (!Number.isInteger(hoistId) || hoistId <= 0) return validationError('hoistId is required.')

  const rawServiceIds = Array.isArray(bkg.serviceTypeIds) ? bkg.serviceTypeIds : []
  const serviceTypeIds = rawServiceIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (serviceTypeIds.length === 0) {
    return validationError('booking.serviceTypeIds must be a non-empty array of positive integers.')
  }

  const customerNotes = typeof bkg.customerNotes === 'string' ? bkg.customerNotes.trim() : null

  const sessionId = typeof meta.sessionId === 'string' && /^[a-f0-9-]{10,64}$/i.test(meta.sessionId)
    ? meta.sessionId
    : ''
  if (!sessionId) return validationError('meta.sessionId is required (UUID recommended).')

  // Marketing attribution — normalised for reports.
  //   - source + medium: trim + lowercase so "Facebook" and "facebook"
  //     don't split the bucket.
  //   - campaign: trim but preserve case (campaign names carry
  //     meaningful capitalisation).
  //   - referer: trim + cap at 500 chars (matches the column length).
  const utmSourceIn   = typeof meta.utmSource   === 'string' ? meta.utmSource.trim()   : ''
  const utmMediumIn   = typeof meta.utmMedium   === 'string' ? meta.utmMedium.trim()   : ''
  const utmCampaignIn = typeof meta.utmCampaign === 'string' ? meta.utmCampaign.trim() : ''
  const refererIn     = typeof meta.referer     === 'string' ? meta.referer.trim()     : ''

  const utmSource   = utmSourceIn   ? utmSourceIn.toLowerCase().slice(0, 64)   : null
  const utmMedium   = utmMediumIn   ? utmMediumIn.toLowerCase().slice(0, 64)   : null
  const utmCampaign = utmCampaignIn ? utmCampaignIn.slice(0, 128)              : null
  const refererUrl  = refererIn     ? refererIn.slice(0, 500)                  : null

  // ── Submission context (device / browser / geo) ────────────────────────
  // Built early so a proxy-config problem (no resolvable IP) surfaces as
  // an INTERNAL_ERROR before we do any DB work. Idempotent replays skip
  // this — the first submission's context wins.
  let submissionContext: ReturnType<typeof buildSubmissionContext>
  try {
    submissionContext = buildSubmissionContext(event, (meta as MetaInput).context)
  } catch (err) {
    console.error('[bookings-create] submission context build failed:', err)
    return serverError(err)
  }

  try {
    // ── Turnstile ───────────────────────────────────────────────────────────
    const okBot = await verifyTurnstile(tsTok, submissionContext.ip)
    if (!okBot) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'TURNSTILE_FAILED', message: 'Bot verification failed.' } }),
      }
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    const [[existing]] = await db.query<any[]>(
      `SELECT b.id, b.booking_ref, b.status,
              b.booking_date, TIME_FORMAT(b.booking_time, '%H:%i') AS booking_time,
              b.customer_id, b.vehicle_id, b.hoist_id, b.assigned_staff_id,
              s.name AS store_name, s.suburb AS store_suburb,
              h.name AS hoist_name,
              st.first_name AS tech_first, st.last_name AS tech_last
       FROM bookings b
       JOIN stores s ON s.id = b.store_id
       LEFT JOIN hoists h ON h.id = b.hoist_id
       LEFT JOIN staff st ON st.id = b.assigned_staff_id
       WHERE b.session_id = ? LIMIT 1`,
      [sessionId],
    )
    if (existing) {
      const [[c]] = await db.query<any[]>('SELECT first_name, last_name FROM customers WHERE id = ?', [existing.customer_id])
      const [[v]] = await db.query<any[]>('SELECT year, make, model FROM vehicles WHERE id = ?', [existing.vehicle_id])
      return jsonResponse(200, {
        booking: {
          bookingReference: existing.booking_ref,
          bookingId:        Number(existing.id),
          status:           existing.status,
          customerName:     `${c.first_name} ${c.last_name}`,
          vehicle:          `${v.year} ${v.make} ${v.model}`,
          store:            { name: existing.store_name, suburb: existing.store_suburb ?? null },
          date:             existing.booking_date instanceof Date ? existing.booking_date.toISOString().slice(0, 10) : String(existing.booking_date).slice(0, 10),
          time:             existing.booking_time,
          hoist:            existing.hoist_id ? { id: Number(existing.hoist_id), name: String(existing.hoist_name) } : null,
          tech:             existing.assigned_staff_id
            ? { id: Number(existing.assigned_staff_id), name: `${existing.tech_first} ${existing.tech_last}` }
            : null,
          message:          'This booking was already submitted — returning the existing record.',
          idempotent:       true,
        },
      })
    }

    // ── Load store + slot (by time, not by id) ─────────────────────────────
    const [[store]] = await db.query<any[]>('SELECT id, name, suburb FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
    if (!store) return validationError('booking.storeId is not a valid store.')

    const slot = await findActiveSlotByTime(db, store.id, time)
    if (!slot) return validationError(`time ${time} is not a bookable slot at this store.`)
    const slotEnum = deriveSlotEnum(time)
    const slotTimeSql = `${time}:00`

    // ── Validate service_type ids ──────────────────────────────────────────
    const [validServices] = await db.query<any[]>(
      `SELECT id, name FROM service_types
       WHERE id IN (${serviceTypeIds.map(() => '?').join(',')})
         AND is_active = 1 AND is_bookable = 1`,
      serviceTypeIds,
    )
    if (validServices.length !== serviceTypeIds.length) {
      return validationError('One or more selected serviceTypeIds are not available for booking.')
    }

    // ── Availability + hoist verification (same rules as /c/bookings) ──────
    const availability = await computeSlotAvailability(db, store.id, date, serviceTypeIds)
    const targetSlot   = availability.slots.find(s => s.id === slot.id)
    if (!availability.storeOpen || !targetSlot?.available) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code:    'SLOT_UNAVAILABLE',
            message: `slot at ${time} on ${date} is not available (${(targetSlot as any)?.reason ?? availability.reason ?? 'unavailable'}).`,
          },
        }),
      }
    }
    const chosenTech = targetSlot.techs.find(t => t.hoistId === hoistId)
    if (!chosenTech) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code:    'SLOT_UNAVAILABLE',
            message: `hoist ${hoistId} is not available for this slot + service.`,
          },
        }),
      }
    }
    const assignedHoistId    = chosenTech.hoistId
    const assignedStaffId    = chosenTech.staffId ?? null

    // ── Upsert customer ────────────────────────────────────────────────────
    let [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1',
      [email],
    )
    if (!customer) {
      const [ins] = await db.query<any>(
        `INSERT INTO customers (first_name, last_name, email, mobile, store_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [firstName, lastName, email, mobile, store.id],
      )
      customer = { id: (ins as any).insertId }
    }

    // ── Upsert vehicle ─────────────────────────────────────────────────────
    let [[vehicle]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE rego = ? AND rego_state = ? LIMIT 1',
      [rego, regoState],
    )
    if (!vehicle) {
      const [ins] = await db.query<any>(
        `INSERT INTO vehicles
           (rego, rego_state, make, model, series, year, fuel_type, transmission, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [rego, regoState, make, model, series, year, fuelType ?? 'petrol', transmission ?? 'automatic'],
      )
      vehicle = { id: (ins as any).insertId }
    }

    // ── Link vehicle → customer ────────────────────────────────────────────
    const [[ownerLink]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicle.id, customer.id],
    )
    let isNewOwnerLink = false
    if (!ownerLink) {
      await db.query(
        `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current, created_at)
         VALUES (?, ?, CURDATE(), 1, NOW())`,
        [vehicle.id, customer.id],
      )
      isNewOwnerLink = true
    }
    if (isNewOwnerLink) {
      // Fire-and-forget — engines run async so we don't block the response.
      await fireEnginesAsync(vehicle.id, customer.id)
    }

    // ── Create booking ─────────────────────────────────────────────────────
    // `bookings.end_time` is a STORED GENERATED column
    // (booking_time + estimated_duration_mins) — MySQL computes it, we
    // must not INSERT into it directly.
    const bookingRef = generateBookingRef()
    const durationMins = (() => {
      const [sh, sm] = slotTimeSql.slice(0, 5).split(':').map(Number)
      const [eh, em] = slot.endTime.slice(0, 5).split(':').map(Number)
      return Math.max(15, (eh * 60 + em) - (sh * 60 + sm))
    })()

    // Status = 'pending' at creation. Hoist + tech are still locked from
    // the availability response — the slot's genuinely taken as soon as
    // the row lands because the availability query only excludes
    // cancelled/rejected/no_show. Confirmation happens in the workshop
    // app via PATCH /bookings/{id} { status: 'confirmed' }, which fires
    // the confirmation email + push and spawns the service_jobs row.
    const [bookingIns] = await db.query<any>(
      `INSERT INTO bookings
         (store_id, booking_ref, session_id, customer_id, vehicle_id,
          booking_date, booking_time, estimated_duration_mins,
          slot, hoist_id, assigned_staff_id,
          drop_off_type, booking_source,
          utm_source, utm_medium, utm_campaign, referer_url,
          submission_context,
          customer_notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'drop_off', 'website', ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
      [
        store.id, bookingRef, sessionId, customer.id, vehicle.id,
        date, slotTimeSql, durationMins,
        slotEnum, assignedHoistId, assignedStaffId,
        utmSource, utmMedium, utmCampaign, refererUrl,
        JSON.stringify(submissionContext),
        customerNotes,
      ],
    )
    const bookingId = Number((bookingIns as any).insertId)

    for (const stId of serviceTypeIds) {
      await db.query(
        `INSERT INTO booking_services (booking_id, service_type_id, sort_order) VALUES (?, ?, 0)`,
        [bookingId, stId],
      )
    }

    // Issue a claim token so the confirmation email can include a
    // magic-link URL the customer can click to view / claim their
    // booking on the workshop app.
    const claimRawToken = await issueClaimToken(db, bookingId)
    const claimUrl = buildClaimUrl(claimRawToken)

    const vehicleLabel = [year, make, model].filter(Boolean).join(' ')
    const customerName = `${firstName} ${lastName}`

    // ── Notify staff + send confirmation email (both non-fatal) ────────────
    await notifyStore(db, store.id, {
      type:      'booking_received',
      title:     'New Booking',
      body:      `${customerName} — ${vehicleLabel} — ${date} ${time}${chosenTech.name ? ` with ${chosenTech.name}` : ''}`,
      bookingId,
    }).catch(err => console.error('notifyStore failed:', err))

    await sendBookingReceivedEmail(db, {
      customerEmail: email,
      customer:      customerName,
      bookingRef,
      date,
      slot:          slotEnum,
      vehicle:       vehicleLabel,
      rego,
      store:         store.name,
      services:      validServices,
      dropOffTime:   null,
      claimUrl,
    }).catch(err => console.error('sendBookingReceivedEmail failed:', err))

    return jsonResponse(201, {
      booking: {
        bookingReference: bookingRef,
        bookingId,
        status:           'pending',
        customerName,
        vehicle:          vehicleLabel,
        store:            { name: store.name, suburb: store.suburb ?? null },
        date,
        time,
        slotLabel:        slot.label ?? null,
        hoist:            { id: chosenTech.hoistId, name: chosenTech.hoistName },
        tech:             chosenTech.staffId
          ? { id: chosenTech.staffId, name: chosenTech.name }
          : null,
        services:         validServices.map((s: any) => s.name).join(', '),
        message:          `Thanks ${firstName} — we'll be in touch to confirm your booking.`,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
