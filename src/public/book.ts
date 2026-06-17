import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { created, serverError } from '../shared/errors'
import { generateBookingRef } from '../bookings/_helpers'
import { sendBookingReceivedEmail } from '../shared/emailTemplates'

const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

async function invokeRecommendationEngine(vehicleId: number, customerId: number): Promise<void> {
  const arn = process.env.AI_RECOMMENDATION_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId, customerId })),
    }))
  } catch (err) {
    console.error('Failed to invoke AIRecommendationEngine:', err)
  }
}

async function invokeVehicleProfileEngine(vehicleId: number): Promise<void> {
  const arn = process.env.VEHICLE_PROFILE_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId })),
    }))
  } catch (err) {
    console.error('Failed to invoke VehicleProfileEngine:', err)
  }
}

const ready = bootstrap()

const VALID_STATES  = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])
const VALID_SLOTS   = new Set(['morning', 'afternoon'])
const VALID_FUEL    = new Set(['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other'])
const VALID_TRANS   = new Set(['manual', 'automatic', 'cvt', 'dct', 'other'])
const VALID_BODY    = new Set(['sedan', 'hatch', 'wagon', 'ute', 'van', 'suv', 'coupe', 'convertible', 'truck', 'other'])
const VALID_DRIVE   = new Set(['fwd', 'rwd', 'awd', '4wd'])
const VALID_REFERAL = new Set(['word_of_mouth', 'google', 'facebook', 'instagram', 'signage', 'other'])

function err422(code: string, message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 422,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, message }),
  }
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

interface ParsedVehicle {
  make: string
  model: string
  year: number
  series:               string | null
  fuelType:             string | null
  transmission:         string | null
  bodyType:             string | null
  engineCode:           string | null
  engineSizeCC:         number | null
  cylinders:            number | null
  driveType:            string | null
  colour:               string | null
  tyreSizeFront:        string | null
  tyreSizeRear:         string | null
  spareTyreSize:        string | null
  serviceIntervalKm:    number | null
  serviceIntervalMonths: number | null
}

async function parseVehicle(description: string): Promise<ParsedVehicle | null> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are an Australian automotive data expert. A customer has described their vehicle below.

Your job is to:
1. Identify the vehicle from the description
2. Use your knowledge of that specific make/model/year to fill in as many fields as possible — do not limit yourself to what the customer wrote. If you know the standard specs for this vehicle, use them.
3. Only leave a field null if you genuinely cannot determine it.

Description: "${description.replace(/"/g, "'")}"

Return JSON only, no markdown:
{
  "make": string,
  "model": string,
  "year": integer,
  "series": string or null,
  "fuelType": "petrol"|"diesel"|"hybrid"|"electric"|"lpg"|"other"|null,
  "transmission": "manual"|"automatic"|"cvt"|"dct"|"other"|null,
  "bodyType": "sedan"|"hatch"|"wagon"|"ute"|"van"|"suv"|"coupe"|"convertible"|"truck"|"other"|null,
  "engineCode": string or null,
  "engineSizeCC": integer (cc) or null,
  "cylinders": integer or null,
  "driveType": "fwd"|"rwd"|"awd"|"4wd"|null,
  "colour": string or null,
  "tyreSizeFront": string (e.g. "185/55R15") or null,
  "tyreSizeRear": string or null,
  "spareTyreSize": string or null,
  "serviceIntervalKm": integer (manufacturer recommended km between services) or null,
  "serviceIntervalMonths": integer (manufacturer recommended months between services) or null,
  "parseError": false
}

Set "parseError": true if you cannot confidently determine make, model, AND year.`

  try {
    const result = await model.generateContent(prompt)
    const parsed = JSON.parse(stripFences(result.response.text()))
    if (parsed.parseError || !parsed.make || !parsed.model || !parsed.year) return null
    return {
      make:                  String(parsed.make),
      model:                 String(parsed.model),
      year:                  Number(parsed.year),
      series:                parsed.series               ?? null,
      fuelType:              VALID_FUEL.has(parsed.fuelType)        ? parsed.fuelType        : null,
      transmission:          VALID_TRANS.has(parsed.transmission)   ? parsed.transmission    : null,
      bodyType:              VALID_BODY.has(parsed.bodyType)        ? parsed.bodyType        : null,
      engineCode:            parsed.engineCode           ?? null,
      engineSizeCC:          parsed.engineSizeCC         ? Number(parsed.engineSizeCC)         : null,
      cylinders:             parsed.cylinders            ? Number(parsed.cylinders)            : null,
      driveType:             VALID_DRIVE.has(parsed.driveType)      ? parsed.driveType       : null,
      colour:                parsed.colour               ?? null,
      tyreSizeFront:         parsed.tyreSizeFront        ?? null,
      tyreSizeRear:          parsed.tyreSizeRear         ?? null,
      spareTyreSize:         parsed.spareTyreSize        ?? null,
      serviceIntervalKm:     parsed.serviceIntervalKm    ? Number(parsed.serviceIntervalKm)    : null,
      serviceIntervalMonths: parsed.serviceIntervalMonths ? Number(parsed.serviceIntervalMonths) : null,
    }
  } catch {
    return null
  }
}

const unauthorized = (): APIGatewayProxyResultV2 => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Unauthorized' }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (event.headers['x-api-key'] !== process.env.BOOKING_API_KEY) return unauthorized()
  const db = getPool()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const {
      firstName, lastName, email, mobile,
      rego, regoState, vehicle, serviceTypeIds, notes,
      preferredDate, slot, storeId, referralSource,
    } = body

    // ── Validate required fields ───────────────────────────────────────────
    if (!firstName || !lastName || !email || !mobile || !rego || !regoState ||
        !vehicle || !preferredDate || !slot || !storeId) {
      return err422('VALIDATION_ERROR', 'Required field missing.')
    }

    if (!Array.isArray(serviceTypeIds) || serviceTypeIds.length === 0) {
      return err422('VALIDATION_ERROR', 'serviceTypeIds must be a non-empty array.')
    }
    const serviceIdList = serviceTypeIds.map(Number)

    const regoStateStr = String(regoState).toUpperCase()
    if (!VALID_STATES.has(regoStateStr)) {
      return err422('VALIDATION_ERROR', 'Invalid state. Must be one of: VIC, NSW, QLD, SA, WA, TAS, NT, ACT.')
    }
    if (!VALID_SLOTS.has(String(slot))) {
      return err422('VALIDATION_ERROR', 'slot must be "morning" or "afternoon".')
    }
    const bookingDate = String(preferredDate)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) || bookingDate < new Date().toISOString().slice(0, 10)) {
      return err422('VALIDATION_ERROR', 'preferredDate must be a future date in YYYY-MM-DD format.')
    }
    if (referralSource != null && !VALID_REFERAL.has(String(referralSource))) {
      return err422('VALIDATION_ERROR', 'Invalid referralSource value.')
    }

    // ── Validate service type IDs ──────────────────────────────────────────
    const [validServices] = await db.query<any[]>(
      `SELECT id, name FROM service_types WHERE id IN (${serviceIdList.map(() => '?').join(',')}) AND is_active = 1 AND is_bookable = 1`,
      serviceIdList,
    )
    if (validServices.length !== serviceIdList.length) {
      return err422('VALIDATION_ERROR', 'One or more selected services are not available for booking.')
    }

    // ── Verify store ───────────────────────────────────────────────────────
    const [[store]] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ? LIMIT 1', [Number(storeId)])
    if (!store) return err422('VALIDATION_ERROR', 'Invalid storeId.')

    // ── Parse vehicle with Gemini ──────────────────────────────────────────
    const parsed = await parseVehicle(String(vehicle))
    if (!parsed) {
      return err422('VEHICLE_PARSE_FAILED', 'Could not identify vehicle from description. Please include the year, make and model — e.g. "2019 Toyota Camry hybrid".')
    }

    // ── Find or create customer ────────────────────────────────────────────
    const emailStr = String(email).toLowerCase().trim()
    let [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1',
      [emailStr],
    )
    if (!customer) {
      const [ins] = await db.query<any>(
        `INSERT INTO customers (first_name, last_name, email, mobile, store_id, referral_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          String(firstName).trim(),
          String(lastName).trim(),
          emailStr,
          String(mobile).trim(),
          store.id,
          referralSource ?? null,
        ],
      )
      customer = { id: ins.insertId }
    }

    // ── Find or create vehicle ─────────────────────────────────────────────
    const regoStr = String(rego).trim().toUpperCase()
    let [[existingVehicle]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE rego = ? AND rego_state = ? LIMIT 1',
      [regoStr, regoStateStr],
    )
    if (!existingVehicle) {
      const [ins] = await db.query<any>(
        `INSERT INTO vehicles
           (rego, rego_state, make, model, series, year, fuel_type, transmission,
            body_type, engine_code, engine_size_cc, cylinders, drive_type,
            colour, tyre_size_front, tyre_size_rear, spare_tyre_size,
            service_interval_km, service_interval_months, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          regoStr,
          regoStateStr,
          parsed.make,
          parsed.model,
          parsed.series,
          parsed.year,
          parsed.fuelType               ?? 'petrol',
          parsed.transmission           ?? 'automatic',
          parsed.bodyType               ?? null,
          parsed.engineCode             ?? null,
          parsed.engineSizeCC           ?? null,
          parsed.cylinders              ?? null,
          parsed.driveType              ?? null,
          parsed.colour                 ?? null,
          parsed.tyreSizeFront          ?? null,
          parsed.tyreSizeRear           ?? null,
          parsed.spareTyreSize          ?? null,
          parsed.serviceIntervalKm      ?? null,
          parsed.serviceIntervalMonths  ?? null,
        ],
      )
      existingVehicle = { id: ins.insertId }
    }

    // ── Link vehicle to customer if not already linked ─────────────────────
    const [[ownerLink]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [existingVehicle.id, customer.id],
    )
    let isNewOwnerLink = false
    if (!ownerLink) {
      await db.query(
        `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current, created_at)
         VALUES (?, ?, CURDATE(), 1, NOW())`,
        [existingVehicle.id, customer.id],
      )
      isNewOwnerLink = true
    }

    // ── Fire AI engines for new vehicle-customer links ─────────────────────
    if (isNewOwnerLink) {
      void invokeRecommendationEngine(existingVehicle.id, customer.id)
      void invokeVehicleProfileEngine(existingVehicle.id)
    }

    // ── Create booking ─────────────────────────────────────────────────────
    const bookingRef  = generateBookingRef()
    const bookingTime = slot === 'morning' ? '09:00:00' : '13:00:00'

    const [bookingIns] = await db.query<any>(
      `INSERT INTO bookings
         (store_id, booking_ref, customer_id, vehicle_id, booking_date, booking_time,
          slot, drop_off_type, booking_source, customer_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'drop_off', 'website', ?, NOW(), NOW())`,
      [
        store.id,
        bookingRef,
        customer.id,
        existingVehicle.id,
        bookingDate,
        bookingTime,
        slot,
        notes ? String(notes).trim() : null,
      ],
    )

    // ── Link service types to booking ──────────────────────────────────────
    const bookingId = bookingIns.insertId
    for (const serviceTypeId of serviceIdList) {
      await db.query(
        `INSERT INTO booking_services (booking_id, service_type_id, created_at) VALUES (?, ?, NOW())`,
        [bookingId, serviceTypeId],
      )
    }

    // ── Send confirmation email (non-fatal) ────────────────────────────────
    const vehicleLabel = `${parsed.year} ${parsed.make} ${parsed.model}`
    await sendBookingReceivedEmail(db, {
      customerEmail: emailStr,
      customer:      `${String(firstName).trim()} ${String(lastName).trim()}`,
      bookingRef,
      date:          bookingDate,
      slot:          String(slot),
      vehicle:       vehicleLabel,
      rego:          regoStr,
      store:         store.name,
      services:      validServices,
      dropOffTime:   null,
    })

    return created({
      bookingReference: bookingRef,
      customerName: `${String(firstName).trim()} ${String(lastName).trim()}`,
      vehicle:      vehicleLabel,
      store:        store.name,
      preferredDate: bookingDate,
      slot,
      message: `Thanks ${String(firstName).trim()} — we'll be in touch to confirm your booking.`,
    })
  } catch (err) {
    return serverError(err)
  }
}
