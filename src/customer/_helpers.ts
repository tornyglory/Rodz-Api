import { APIGatewayProxyEventV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { imageUrls } from '../shared/cloudflare'

export interface CustomerContext {
  customerId: number
}

export function getCustomerContext(event: APIGatewayProxyEventV2): CustomerContext {
  const ctx = (event.requestContext as any).authorizer?.lambda ?? {}
  return { customerId: Number(ctx.customerId ?? 0) }
}

export async function isPremium(db: any, customerId: number): Promise<boolean> {
  const [[cust]] = await db.query<any[]>(
    'SELECT is_premium FROM customers WHERE id = ? LIMIT 1',
    [customerId],
  )
  return !!cust?.is_premium
}

export function buildVehicleSummary(row: any) {
  return {
    id:            row.id            as number,
    rego:          row.rego          as string,
    label:         `${row.year} ${row.make} ${row.model}`,
    avatarUrl:     row.avatar_image_id ? imageUrls(row.avatar_image_id).thumbnail : null,
    coverUrl:      row.cover_image_id  ? imageUrls(row.cover_image_id).public      : null,
    logbookToken:  row.logbook_token   ?? null,
  }
}

export function buildVehicle(row: any) {
  return {
    id:                   row.id                  as number,
    rego:                 row.rego                as string,
    regoState:            row.rego_state          ?? null,
    regoExpiry:           row.rego_expiry         ? toDate(row.rego_expiry) : null,
    vin:                  row.vin                 ?? null,
    make:                 row.make                as string,
    model:                row.model               as string,
    series:               row.series              ?? null,
    year:                 row.year                as number,
    colour:               row.colour              ?? null,
    bodyType:             row.body_type           ?? null,
    fuelType:             row.fuel_type           ?? null,
    transmission:         row.transmission        ?? null,
    driveType:            row.drive_type          ?? null,
    engineCode:           row.engine_code         ?? null,
    engineSizeCC:         row.engine_size_cc      ? Number(row.engine_size_cc)       : null,
    cylinders:            row.cylinders           ? Number(row.cylinders)            : null,
    tyreSizeFront:        row.tyre_size_front     ?? null,
    tyreSizeRear:         row.tyre_size_rear      ?? null,
    odometerKm:           row.odometer_current    ? Number(row.odometer_current)     : null,
    nextServiceDueKm:     row.next_service_due_km ? Number(row.next_service_due_km)  : null,
    nextServiceDueDate:   row.next_service_due_date ? toDate(row.next_service_due_date) : null,
    serviceIntervalKm:    row.service_interval_km ? Number(row.service_interval_km)  : null,
    serviceIntervalMonths: row.service_interval_months ? Number(row.service_interval_months) : null,
    avatarUrl:            row.avatar_image_id ? imageUrls(row.avatar_image_id).thumbnail : null,
    coverUrl:             row.cover_image_id  ? imageUrls(row.cover_image_id).public      : null,
    logbookToken:         row.logbook_token   ?? null,
    forSale:              !!row.for_sale,
    askingPrice:          row.asking_price != null ? Number(row.asking_price) : null,
    city:                 row.city    ?? null,
    country:              row.country ?? null,
    description:          row.description ?? null,
  }
}

export function buildCustomer(row: any, vehicles: ReturnType<typeof buildVehicleSummary>[]) {
  const avatarUrls = row.avatar_image_id ? imageUrls(row.avatar_image_id) : null
  return {
    id:             row.id          as number,
    firstName:      row.first_name  as string,
    lastName:       row.last_name   as string,
    email:          row.email       as string,
    mobile:         row.mobile      as string,
    suburb:         row.suburb      ?? null,
    state:          row.state       ?? null,
    postcode:       row.postcode    ?? null,
    description:    row.description ?? null,
    dateOfBirth:    row.date_of_birth ? toDate(row.date_of_birth) : null,
    gender:         row.gender        ?? null,
    avatarUrl:      avatarUrls?.public    ?? null,
    avatarThumbUrl: avatarUrls?.thumbnail ?? null,
    isPremium:      Boolean(row.is_premium),
    marketingOptIn: Boolean(row.marketing_opt_in),
    smsOptIn:       Boolean(row.sms_opt_in),
    memberSince:    row.created_at ? toDate(row.created_at) : null,
    onboardingCompletedAt: toIsoDateTime(row.onboarding_completed_at),
    vehicles,
  }
}

function toDate(v: any): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

function toIsoDateTime(v: any): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString()
}

// ── Vehicle parsing ──────────────────────────────────────────────────────────

const VALID_FUEL  = new Set(['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other'])
const VALID_TRANS = new Set(['manual', 'automatic', 'cvt', 'dct', 'other'])
const VALID_BODY  = new Set(['sedan', 'hatch', 'wagon', 'ute', 'van', 'suv', 'coupe', 'convertible', 'truck', 'other'])
const VALID_DRIVE = new Set(['fwd', 'rwd', 'awd', '4wd'])

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

export interface ParsedVehicle {
  make:                  string
  model:                 string
  year:                  number
  series:                string | null
  fuelType:              string | null
  transmission:          string | null
  bodyType:              string | null
  engineCode:            string | null
  engineSizeCC:          number | null
  cylinders:             number | null
  driveType:             string | null
  colour:                string | null
  tyreSizeFront:         string | null
  tyreSizeRear:          string | null
  spareTyreSize:         string | null
  serviceIntervalKm:     number | null
  serviceIntervalMonths: number | null
}

export async function parseVehicle(description: string): Promise<ParsedVehicle | { error: string }> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are an Australian automotive data expert. A customer has described their vehicle below.

Your job is to:
1. Identify the vehicle from the description
2. Always use the year the customer states — do not reject or second-guess it.
3. Use your knowledge of that specific make/model to fill in as many fields as possible.
4. Only leave a field null if you genuinely cannot determine it.

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
  "tyreSizeFront": string or null,
  "tyreSizeRear": string or null,
  "spareTyreSize": string or null,
  "serviceIntervalKm": integer or null,
  "serviceIntervalMonths": integer or null,
  "parseError": false,
  "parseErrorReason": null
}

Set "parseError": true only if you cannot determine make OR model from the description.`

  try {
    const result = await model.generateContent(prompt)
    const parsed = JSON.parse(stripFences(result.response.text()))
    if (parsed.parseError || !parsed.make || !parsed.model || !parsed.year) {
      return { error: parsed.parseErrorReason ?? 'We couldn\'t identify the vehicle. Please include the year, make and model — e.g. "2019 Toyota Camry".' }
    }
    return {
      make:                  String(parsed.make),
      model:                 String(parsed.model),
      year:                  Number(parsed.year),
      series:                parsed.series               ?? null,
      fuelType:              VALID_FUEL.has(parsed.fuelType)    ? parsed.fuelType    : null,
      transmission:          VALID_TRANS.has(parsed.transmission) ? parsed.transmission : null,
      bodyType:              VALID_BODY.has(parsed.bodyType)    ? parsed.bodyType    : null,
      engineCode:            parsed.engineCode           ?? null,
      engineSizeCC:          parsed.engineSizeCC         ? Number(parsed.engineSizeCC)         : null,
      cylinders:             parsed.cylinders            ? Number(parsed.cylinders)            : null,
      driveType:             VALID_DRIVE.has(parsed.driveType)  ? parsed.driveType   : null,
      colour:                parsed.colour               ?? null,
      tyreSizeFront:         parsed.tyreSizeFront        ?? null,
      tyreSizeRear:          parsed.tyreSizeRear         ?? null,
      spareTyreSize:         parsed.spareTyreSize        ?? null,
      serviceIntervalKm:     parsed.serviceIntervalKm    ? Number(parsed.serviceIntervalKm)    : null,
      serviceIntervalMonths: parsed.serviceIntervalMonths ? Number(parsed.serviceIntervalMonths) : null,
    }
  } catch {
    return { error: 'Failed to parse vehicle description. Please try again.' }
  }
}
