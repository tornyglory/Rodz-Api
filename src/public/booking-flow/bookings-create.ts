import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, serverError, validationError } from '../../shared/errors'
import { generateBookingRef } from '../../bookings/_helpers'
import { sendBookingReceivedEmail } from '../../shared/emailTemplates'
import { notifyStore } from '../../shared/staffNotifications'
import { issueClaimToken, buildClaimUrl } from './_claim-token'

const ready = bootstrap()

const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /public/bookings
//
// Guest booking creation for the 11-step flow at
// workshop.rodz.com.au/book. Distinct from POST /book (the older
// one-page website form) — this endpoint takes structured vehicle
// data (already picked from the catalog by the frontend), uses
// slot_id from the /booking-slots endpoint, verifies a Cloudflare
// Turnstile token, and dedupes repeat submits via meta.sessionId.
//
// Payload shape (all nested):
//   customer:      { firstName, lastName, email, mobile }
//   vehicle:       { year, make, model, series?, rego, regoState,
//                    fuelType?, transmission?, avgKmPerWeek? }
//   booking:       { storeId, date, slotId, serviceTypeIds[], customerNotes? }
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
  storeId?: unknown; date?: unknown; slotId?: unknown
  serviceTypeIds?: unknown; customerNotes?: unknown
}
interface MetaInput {
  sessionId?: unknown
  utmSource?: unknown; utmMedium?: unknown; utmCampaign?: unknown; referer?: unknown
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

  const year  = Number(veh.year)
  const make  = typeof veh.make  === 'string' ? veh.make.trim()  : ''
  const model = typeof veh.model === 'string' ? veh.model.trim() : ''
  const rego  = typeof veh.rego  === 'string' ? veh.rego.trim().toUpperCase() : ''
  const regoState = typeof veh.regoState === 'string' ? veh.regoState.trim().toUpperCase() : ''
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return validationError('vehicle.year must be a valid year.')
  }
  if (!make || !model) return validationError('vehicle.make and vehicle.model are required.')
  if (!rego) return validationError('vehicle.rego is required.')
  if (!VALID_STATES.has(regoState)) {
    return validationError(`vehicle.regoState must be one of: ${[...VALID_STATES].join(', ')}.`)
  }
  const series       = typeof veh.series       === 'string' ? veh.series.trim() : null
  const fuelType     = typeof veh.fuelType     === 'string' && VALID_FUEL.has(veh.fuelType.toLowerCase())  ? veh.fuelType.toLowerCase()  : null
  const transmission = typeof veh.transmission === 'string' && VALID_TRANS.has(veh.transmission.toLowerCase()) ? veh.transmission.toLowerCase() : null

  const storeId = Number(bkg.storeId)
  const date    = typeof bkg.date === 'string' ? bkg.date : ''
  const slotId  = Number(bkg.slotId)
  if (!Number.isInteger(storeId) || storeId <= 0) return validationError('booking.storeId is required.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))         return validationError('booking.date must be YYYY-MM-DD.')
  if (!Number.isInteger(slotId) || slotId <= 0)  return validationError('booking.slotId is required.')

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

  const attribution = {
    utmSource:   typeof meta.utmSource   === 'string' ? meta.utmSource.slice(0, 120)   : null,
    utmMedium:   typeof meta.utmMedium   === 'string' ? meta.utmMedium.slice(0, 120)   : null,
    utmCampaign: typeof meta.utmCampaign === 'string' ? meta.utmCampaign.slice(0, 120) : null,
    referer:     typeof meta.referer     === 'string' ? meta.referer.slice(0, 500)     : null,
  }

  try {
    // ── Turnstile ───────────────────────────────────────────────────────────
    const remoteIp = event.requestContext?.http?.sourceIp
    const okBot = await verifyTurnstile(tsTok, remoteIp)
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
              b.customer_id, b.vehicle_id, s.name AS store_name
       FROM bookings b
       JOIN stores s ON s.id = b.store_id
       WHERE b.session_id = ? LIMIT 1`,
      [sessionId],
    )
    if (existing) {
      const [[c]] = await db.query<any[]>('SELECT first_name, last_name FROM customers WHERE id = ?', [existing.customer_id])
      const [[v]] = await db.query<any[]>('SELECT year, make, model FROM vehicles WHERE id = ?', [existing.vehicle_id])
      return jsonResponse(200, {
        bookingReference: existing.booking_ref,
        bookingId:        Number(existing.id),
        status:           existing.status,
        customerName:     `${c.first_name} ${c.last_name}`,
        vehicle:          `${v.year} ${v.make} ${v.model}`,
        store:            existing.store_name,
        date:             existing.booking_date instanceof Date ? existing.booking_date.toISOString().slice(0, 10) : String(existing.booking_date).slice(0, 10),
        time:             existing.booking_time,
        message:          'This booking was already submitted — returning the existing record.',
        idempotent:       true,
      })
    }

    // ── Load store + slot ──────────────────────────────────────────────────
    const [[store]] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
    if (!store) return validationError('booking.storeId is not a valid store.')

    const [[slot]] = await db.query<any[]>(
      `SELECT id, TIME_FORMAT(slot_time, '%H:%i:00') AS slot_time,
              TIME_FORMAT(slot_time, '%H') AS slot_hour, label
       FROM store_booking_slots
       WHERE id = ? AND store_id = ? AND is_active = 1 LIMIT 1`,
      [slotId, store.id],
    )
    if (!slot) return validationError('booking.slotId is not a valid slot for this store.')
    const slotEnum: 'morning' | 'afternoon' = Number(slot.slot_hour) < 12 ? 'morning' : 'afternoon'

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

    // ── Slot capacity check ────────────────────────────────────────────────
    const [[{ booked }]] = await db.query<any[]>(
      `SELECT COUNT(*) AS booked FROM bookings
       WHERE store_id = ? AND booking_date = ? AND booking_time = ?
         AND cancelled_at IS NULL AND status NOT IN ('cancelled', 'rejected', 'no_show')`,
      [store.id, date, slot.slot_time],
    )
    const [[{ hoist_count }]] = await db.query<any[]>(
      'SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1',
      [store.id],
    )
    if (Number(booked) >= Number(hoist_count)) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'SLOT_UNAVAILABLE', message: 'This slot is no longer available. Please choose another.' } }),
      }
    }

    // ── Assign first free hoist ────────────────────────────────────────────
    const [[freeHoist]] = await db.query<any[]>(
      `SELECT id FROM hoists
       WHERE store_id = ? AND is_active = 1
         AND id NOT IN (
           SELECT hoist_id FROM bookings
           WHERE store_id = ? AND booking_date = ? AND booking_time = ?
             AND cancelled_at IS NULL AND status NOT IN ('cancelled', 'rejected', 'no_show')
             AND hoist_id IS NOT NULL
         )
       ORDER BY id LIMIT 1`,
      [store.id, store.id, date, slot.slot_time],
    )
    const assignedHoistId: number | null = freeHoist?.id ?? null

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
    const bookingRef = generateBookingRef()
    const [bookingIns] = await db.query<any>(
      `INSERT INTO bookings
         (store_id, booking_ref, session_id, customer_id, vehicle_id,
          booking_date, booking_time, slot, hoist_id,
          drop_off_type, booking_source, attribution,
          customer_notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'drop_off', 'website', ?, ?, 'pending', NOW(), NOW())`,
      [
        store.id, bookingRef, sessionId, customer.id, vehicle.id,
        date, slot.slot_time, slotEnum, assignedHoistId,
        JSON.stringify(attribution),
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

    const vehicleLabel = `${year} ${make} ${model}`
    const customerName = `${firstName} ${lastName}`

    // ── Notify staff + send confirmation email (both non-fatal) ────────────
    await notifyStore(db, store.id, {
      type:      'booking_received',
      title:     'New Booking',
      body:      `${customerName} — ${vehicleLabel} — ${date} (${slot.label ?? slotEnum})`,
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
      bookingReference: bookingRef,
      bookingId,
      status:           'pending',
      customerName,
      vehicle:          vehicleLabel,
      store:            store.name,
      date,
      time:             (slot.slot_time as string).slice(0, 5),
      slotLabel:        slot.label ?? null,
      message:          `Thanks ${firstName} — we'll be in touch to confirm your booking.`,
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
