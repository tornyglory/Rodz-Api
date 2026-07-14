import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI, Content, Part } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { notFound, gone, forbidden, badRequest, serverError } from '../shared/errors'
import { checkAndRecord } from '../shared/rateLimit'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'

const ready = bootstrap()

const MAX_MESSAGE_LEN     = 2000
const MAX_HISTORY_TURNS   = 20
const MAX_HISTORY_CONTENT = 4000

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function toDate(v: any): string {
  if (!v) return ''
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

async function buildPublicVehicleContext(db: mysql.Pool, vehicleId: number, rego: string): Promise<string> {
  const [[v], [profile], [logs], [fuelRows]] = await Promise.all([
    db.query<any[]>(
      `SELECT make, model, year, series, colour, body_type, fuel_type, transmission, drive_type,
              engine_code, engine_size_cc, cylinders, tyre_size_front, tyre_size_rear,
              odometer_current, vin, for_sale, asking_price, city, country
         FROM vehicles WHERE id = ? LIMIT 1`,
      [vehicleId],
    ),
    db.query<any[]>(
      `SELECT overview, engine_specs, service_notes, known_issues, common_repairs
         FROM vehicle_model_profiles
        WHERE make = (SELECT make FROM vehicles WHERE id = ? LIMIT 1)
          AND model = (SELECT model FROM vehicles WHERE id = ? LIMIT 1)
          AND year = (SELECT year FROM vehicles WHERE id = ? LIMIT 1)
        LIMIT 1`,
      [vehicleId, vehicleId, vehicleId],
    ),
    db.query<any[]>(
      `SELECT vsl.service_date, COALESCE(i.odometer_in, vsl.odometer) AS odometer,
              vsl.store, vsl.total, vsl.ai_summary
         FROM vehicle_service_log vsl
         LEFT JOIN invoices i ON i.id = vsl.invoice_id
        WHERE vsl.vehicle_rego = ?
        ORDER BY vsl.service_date DESC LIMIT 12`,
      [rego],
    ),
    db.query<any[]>(
      `SELECT expense_date, odometer_km, fuel_litres, amount_aud, price_per_litre, fuel_type
         FROM vehicle_expenses
        WHERE vehicle_id = ? AND category = 'fuel'
        ORDER BY expense_date DESC LIMIT 12`,
      [vehicleId],
    ),
  ])

  const vehicle = v[0]
  if (!vehicle) return ''

  const lines: string[] = [
    `## Vehicle`,
    `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.series ? ` (${vehicle.series})` : ''}`,
  ]
  if (vehicle.colour)           lines.push(`Colour: ${vehicle.colour}`)
  if (vehicle.body_type)        lines.push(`Body: ${vehicle.body_type}`)
  if (vehicle.fuel_type)        lines.push(`Fuel: ${vehicle.fuel_type}`)
  if (vehicle.transmission)     lines.push(`Transmission: ${vehicle.transmission}`)
  if (vehicle.drive_type)       lines.push(`Drive: ${vehicle.drive_type}`)
  if (vehicle.engine_size_cc)   lines.push(`Engine: ${(Number(vehicle.engine_size_cc) / 1000).toFixed(1)}L${vehicle.cylinders ? ` ${vehicle.cylinders}-cyl` : ''}${vehicle.engine_code ? ` (${vehicle.engine_code})` : ''}`)
  if (vehicle.odometer_current) lines.push(`Odometer: ${Number(vehicle.odometer_current).toLocaleString()} km`)
  if (vehicle.tyre_size_front)  lines.push(`Tyres: ${vehicle.tyre_size_front}${vehicle.tyre_size_rear && vehicle.tyre_size_rear !== vehicle.tyre_size_front ? ` front / ${vehicle.tyre_size_rear} rear` : ''}`)
  if (vehicle.vin)              lines.push(`VIN: ${vehicle.vin}`)

  if (vehicle.for_sale) {
    lines.push('', '## Listing')
    lines.push(`Listed for sale${vehicle.asking_price ? ` at $${Number(vehicle.asking_price).toLocaleString()} AUD` : ''}`)
    if (vehicle.city || vehicle.country) lines.push(`Location: ${[vehicle.city, vehicle.country].filter(Boolean).join(', ')}`)
  }

  const p = profile[0]
  if (p) {
    if (p.overview) lines.push('', '## Model Overview', String(p.overview))
    const specs = typeof p.engine_specs === 'string' ? safeParse(p.engine_specs) : p.engine_specs
    if (specs) {
      const specLines: string[] = []
      if (specs.oilType)       specLines.push(`Recommended oil: ${specs.oilType}${specs.oilCapacityL ? ` (${specs.oilCapacityL}L with filter)` : ''}`)
      if (specs.timingDrive)   specLines.push(`Timing: ${specs.timingDrive}${specs.timingBeltIntervalKm ? ` — belt/chain due every ${Number(specs.timingBeltIntervalKm).toLocaleString()} km` : ''}`)
      if (specs.sparkPlugType) specLines.push(`Spark plugs: ${specs.sparkPlugType}${specs.sparkPlugIntervalKm ? ` — replace every ${Number(specs.sparkPlugIntervalKm).toLocaleString()} km` : ''}`)
      if (specLines.length) lines.push('', '## Engine Specs', ...specLines)
    }
    const issues = typeof p.known_issues === 'string' ? safeParse(p.known_issues) : p.known_issues
    if (Array.isArray(issues) && issues.length) {
      lines.push('', '## Known Issues for This Model')
      issues.forEach((i: any) => lines.push(`- ${i.title}: ${i.description}${i.severity === 'critical' ? ' ⚠️ Safety-critical' : ''}`))
    }
    const repairs = typeof p.common_repairs === 'string' ? safeParse(p.common_repairs) : p.common_repairs
    if (Array.isArray(repairs) && repairs.length) {
      lines.push('', '## Common Repairs')
      repairs.slice(0, 6).forEach((r: any) => lines.push(`- ${r.name ?? r.title}${r.typicalCostAud ? ` (~$${r.typicalCostAud} AUD)` : ''}`))
    }
    if (p.service_notes) lines.push('', '## Service Notes', String(p.service_notes))
  }

  if (logs.length) {
    lines.push('', '## Service History (most recent first)')
    for (const job of logs as any[]) {
      const date    = toDate(job.service_date)
      const odo     = job.odometer ? ` @ ${Number(job.odometer).toLocaleString()} km` : ''
      const total   = job.total ? ` — $${Number(job.total).toFixed(0)}` : ''
      const store   = job.store ? ` at ${job.store}` : ''
      const summary = job.ai_summary ? `: ${String(job.ai_summary).split('.')[0]}` : ''
      lines.push(`${date}${odo}${total}${store}${summary}`)
    }
  }

  if (fuelRows.length >= 2) {
    const totalLitres = (fuelRows as any[]).reduce((s: number, r: any) => s + (r.fuel_litres ? Number(r.fuel_litres) : 0), 0)
    const totalAud    = (fuelRows as any[]).reduce((s: number, r: any) => s + (r.amount_aud ? Number(r.amount_aud) : 0), 0)
    const withOdo     = (fuelRows as any[]).filter((r: any) => r.odometer_km != null && r.fuel_litres != null)
    lines.push('', `## Fuel History (last ${fuelRows.length} fills)`)
    lines.push(`Total ${totalLitres.toFixed(0)}L for $${totalAud.toFixed(0)} AUD across recent fills.`)
    if (withOdo.length >= 2) {
      const sorted   = [...withOdo].sort((a, b) => Number(a.odometer_km) - Number(b.odometer_km))
      const kmSpan   = Number(sorted[sorted.length - 1].odometer_km) - Number(sorted[0].odometer_km)
      const litres   = sorted.reduce((s: number, r: any) => s + Number(r.fuel_litres), 0)
      if (kmSpan > 0 && litres > 0) {
        const lPer100 = (litres / kmSpan) * 100
        lines.push(`Consumption: ~${lPer100.toFixed(1)} L/100km observed over ${kmSpan.toLocaleString()} km.`)
      }
    }
  }

  return lines.join('\n')
}

function safeParse(v: any): any {
  try { return JSON.parse(v) } catch { return null }
}

function buildSystemPrompt(vehicleContext: string, forSale: boolean, contact: { name: string | null; phone: string | null; email: string | null }): string {
  const today = new Date().toISOString().slice(0, 10)

  const contactBlock = forSale && (contact.name || contact.phone || contact.email)
    ? `\n\nSeller contact (only mention if the user asks about buying, contacting the seller, or the listing):\n${[contact.name && `Name: ${contact.name}`, contact.phone && `Phone: ${contact.phone}`, contact.email && `Email: ${contact.email}`].filter(Boolean).join('\n')}`
    : ''

  return `You are Rodz, a friendly and knowledgeable automotive assistant for Rodz workshop — an Australian workshop chain.

You are answering questions from an anonymous visitor (a potential buyer, a curious mechanic, or someone the owner shared this vehicle's public profile link with). You are NOT talking to the owner. You do not know who they are.

Today is ${today}. Keep responses conversational, concise, and use plain English. Markdown for lists/emphasis is fine.

Here is everything you know about this specific vehicle:

${vehicleContext}${contactBlock}

STRICT RULES — you must follow these without exception:

1. Do NOT offer to book a service, quote a repair, take payment, or make any commitment on behalf of Rodz. If the visitor asks to book, tell them: "I can't book from here — please visit rodz.com.au or contact the seller directly." Do not invent booking availability or workshop details.

2. Do NOT fabricate service history. Only reference services that appear in the "Service History" section above. If the visitor asks about a service you don't see, say the logbook doesn't show it rather than inventing one.

3. Do NOT reveal the owner's identity, private expenses, tax information, business expense categorisation, or any personal details. The only owner-related information you may share is the seller contact block above, and only when the visitor is asking about the listing.

4. Do NOT discuss other vehicles owned by this person — you have no information about them and this profile is scoped to a single vehicle.

5. If the visitor asks about workshop-internal information (job cards, technician notes, purchase orders, staff), politely decline — you don't have that information.

6. You CAN use your general automotive knowledge to reason about the make/model — known faults, service intervals, part compatibility, typical costs — even for things not in the logbook. Be clear when you're speaking about the model generally vs this specific vehicle's recorded history.

7. For anything safety-critical (brakes, steering, tyres, structural), always recommend the visitor get a professional inspection before making decisions.

Keep answers focused, warm, and useful.`
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    if (!token) return notFound('Vehicle')

    // Look up vehicle + is_active in one query to distinguish 404 vs 410
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, rego, is_active, for_sale, public_profile_settings FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.chat) return forbidden('CHAT_DISABLED', 'The owner has disabled the assistant for this vehicle.')

    const body    = safeParse(event.body ?? '{}') ?? {}
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message)                   return badRequest('message is required.')
    if (message.length > MAX_MESSAGE_LEN) return badRequest(`message must be ${MAX_MESSAGE_LEN} characters or fewer.`)

    const rawHistory = Array.isArray(body.history) ? body.history : []
    const history: { role: 'user' | 'assistant'; content: string }[] = rawHistory
      .slice(-MAX_HISTORY_TURNS)
      .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, MAX_HISTORY_CONTENT) }))

    // Rate limiting — token, IP, and token+IP buckets
    const ip = (event.requestContext as any)?.http?.sourceIp ?? 'unknown'
    const rateResult = await checkAndRecord(db, [
      { key: `token:${token}`,         limit: 30, windowSeconds: 3600 },
      { key: `ip:${ip}`,               limit: 60, windowSeconds: 3600 },
      { key: `token:${token}|ip:${ip}`, limit: 20, windowSeconds: 900  },
    ])

    if (!rateResult.ok) {
      console.warn(`Rate limit hit: token=${token} ip=${ip} retry=${rateResult.retryAfter}s`)
      return json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
        { 'Retry-After': String(rateResult.retryAfter) },
      )
    }

    // Load contact only if the vehicle is listed (spec: seller contact allowed when for_sale)
    let contact: { name: string | null; phone: string | null; email: string | null } = { name: null, phone: null, email: null }
    if (vehicle.for_sale) {
      const [[owner]] = await db.query<any[]>(
        `SELECT CONCAT(c.first_name, ' ', c.last_name) AS name, c.mobile AS phone, c.email
           FROM vehicle_owners vo JOIN customers c ON c.id = vo.customer_id
          WHERE vo.vehicle_id = ? AND vo.is_current = 1 LIMIT 1`,
        [vehicle.id],
      )
      if (owner) contact = { name: owner.name ?? null, phone: owner.phone ?? null, email: owner.email ?? null }
    }

    const vehicleContext = await buildPublicVehicleContext(db, vehicle.id, vehicle.rego)
    const systemPrompt   = buildSystemPrompt(vehicleContext, !!vehicle.for_sale, contact)

    const contents: Content[] = history.map(h => ({
      role:  h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content } as Part],
    }))
    contents.push({ role: 'user', parts: [{ text: message }] })

    const start = Date.now()
    let reply: string
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
      const model = genAI.getGenerativeModel({
        model:             'gemini-2.5-flash',
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        generationConfig:  { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } } as any,
      })
      const result = await model.generateContent({ contents })
      reply        = result.response.text().trim()
      if (!reply) throw new Error('Empty LLM response')
    } catch (err) {
      console.error('LLM error on public chat:', err)
      return json(503, { error: { code: 'AI_UNAVAILABLE', message: 'The assistant is temporarily unavailable. Please try again shortly.' } })
    }

    const latencyMs = Date.now() - start
    console.log(JSON.stringify({
      event:        'public_chat',
      token,
      ip,
      messageLen:   message.length,
      historyTurns: history.length,
      replyLen:     reply.length,
      latencyMs,
    }))

    return json(200, { reply })
  } catch (err) {
    return serverError(err)
  }
}
