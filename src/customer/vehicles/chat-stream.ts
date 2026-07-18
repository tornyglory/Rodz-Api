import jwt from 'jsonwebtoken'
import { GoogleGenerativeAI, Part, Content, SchemaType, Tool } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import {
  assistantPersonaPreamble,
  ASSISTANT_VALUES,
  ASSISTANT_WORKSHOP_FRAMING,
  ASSISTANT_DIAGNOSIS_FLOW,
  ASSISTANT_SAFETY_RAILS,
  ASSISTANT_IDENTITY,
} from '../../shared/assistantPersona'

const ready = bootstrap()

// awslambda is a global in the Node.js Lambda runtime
declare const awslambda: {
  streamifyResponse(
    handler: (event: any, responseStream: any, context: any) => Promise<void>,
  ): any
  HttpResponseStream: {
    from(stream: any, metadata: { statusCode: number; headers: Record<string, string> }): any
  }
}

const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''
const JWT_SECRET = process.env.JWT_SECRET ?? ''

function sse(stream: any, data: object) {
  stream.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function fetchImageAsBase64(imageId: string): Promise<{ base64: string; mimeType: string }> {
  const url  = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const base64   = Buffer.from(await res.arrayBuffer()).toString('base64')
  return { base64, mimeType }
}

async function buildCustomerVehicleContext(db: mysql.Pool, vehicleId: number): Promise<string> {
  const [[v]] = await db.query<any[]>(
    `SELECT v.make, v.model, v.year, v.series, v.rego, v.rego_state, v.fuel_type, v.transmission,
            v.engine_code, v.engine_size_cc, v.cylinders, v.body_type, v.colour,
            v.tyre_size_front, v.tyre_size_rear, v.odometer_current,
            v.next_service_due_km, v.next_service_due_date,
            v.service_interval_km, v.service_interval_months
     FROM vehicles v WHERE v.id = ? AND v.is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return ''

  const lines: string[] = [
    `## Your Vehicle`,
    `${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}`,
    `Rego: ${v.rego} ${v.rego_state}`,
    `Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}`,
  ]
  if (v.colour)          lines.push(`Colour: ${v.colour}`)
  if (v.odometer_current) lines.push(`Current odometer: ${Number(v.odometer_current).toLocaleString()} km`)
  if (v.engine_code)     lines.push(`Engine: ${v.engine_code}${v.engine_size_cc ? ` ${v.engine_size_cc}cc` : ''}${v.cylinders ? ` ${v.cylinders}-cyl` : ''}`)
  if (v.tyre_size_front) lines.push(`Tyres: ${v.tyre_size_front}${v.tyre_size_rear && v.tyre_size_rear !== v.tyre_size_front ? ` front / ${v.tyre_size_rear} rear` : ''}`)
  if (v.service_interval_km) {
    lines.push(`Service interval: every ${Number(v.service_interval_km).toLocaleString()} km${v.service_interval_months ? ` or ${v.service_interval_months} months` : ''}`)
  }
  if (v.next_service_due_km || v.next_service_due_date) {
    const parts = []
    if (v.next_service_due_km) parts.push(`${Number(v.next_service_due_km).toLocaleString()} km`)
    if (v.next_service_due_date) {
      const d = v.next_service_due_date instanceof Date
        ? v.next_service_due_date.toISOString().slice(0, 10)
        : String(v.next_service_due_date).slice(0, 10)
      parts.push(d)
    }
    lines.push(`Next service due: ${parts.join(' or ')}`)
  }

  // Technical profile
  const [[profile]] = await db.query<any[]>(
    `SELECT overview, engine_specs, service_notes, known_issues
     FROM vehicle_model_profiles WHERE make = ? AND model = ? AND year = ? LIMIT 1`,
    [v.make, v.model, v.year],
  )
  if (profile) {
    if (profile.overview) lines.push('', '## Vehicle Profile', profile.overview)

    const specs = typeof profile.engine_specs === 'string' ? JSON.parse(profile.engine_specs) : profile.engine_specs
    if (specs) {
      if (specs.oilType)       lines.push(`Recommended oil: ${specs.oilType}${specs.oilCapacityL ? ` (${specs.oilCapacityL}L with filter)` : ''}`)
      if (specs.timingDrive)   lines.push(`Timing: ${specs.timingDrive}${specs.timingBeltIntervalKm ? ` — belt/chain due every ${Number(specs.timingBeltIntervalKm).toLocaleString()} km` : ''}`)
      if (specs.sparkPlugType) lines.push(`Spark plugs: ${specs.sparkPlugType}${specs.sparkPlugIntervalKm ? ` — replace every ${Number(specs.sparkPlugIntervalKm).toLocaleString()} km` : ''}`)
    }

    const issues = typeof profile.known_issues === 'string' ? JSON.parse(profile.known_issues) : profile.known_issues
    if (Array.isArray(issues) && issues.length) {
      lines.push('', '## Known Issues for This Model')
      issues.forEach((i: any) => lines.push(`- ${i.title}: ${i.description}${i.severity === 'critical' ? ' ⚠️ Safety-critical' : ''}`))
    }
  }

  // Service history
  const [logs] = await db.query<any[]>(
    `SELECT vsl.service_date, COALESCE(i.odometer_in, vsl.odometer) AS odometer,
            vsl.store, vsl.total, vsl.ai_summary
     FROM vehicle_service_log vsl
     JOIN invoices i ON i.id = vsl.invoice_id
     WHERE vsl.vehicle_rego = ?
     ORDER BY vsl.service_date DESC
     LIMIT 8`,
    [v.rego],
  )
  if (logs.length) {
    lines.push('', '## Service History (most recent first)')
    for (const job of logs) {
      const date = job.service_date instanceof Date
        ? job.service_date.toISOString().slice(0, 10)
        : String(job.service_date).slice(0, 10)
      const odo = job.odometer ? ` @ ${Number(job.odometer).toLocaleString()} km` : ''
      const summary = job.ai_summary ? `: ${job.ai_summary.split('.')[0]}` : ''
      lines.push(`${date}${odo} — $${Number(job.total).toFixed(0)} at ${job.store ?? 'Rodz'}${summary}`)
    }
  }

  return lines.join('\n')
}

async function checkAvailability(db: mysql.Pool, storeId: number, month: string): Promise<object> {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
    [storeId],
  )
  if (!store) return { error: 'Store not found' }

  const [year, mon] = month.split('-').map(Number)
  const firstDay = `${month}-01`
  const lastDay  = new Date(year, mon, 0).toISOString().slice(0, 10)

  const [hoistResult, hoursResult, bookingsResult] = await Promise.all([
    db.query<any[]>('SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1', [storeId]),
    db.query<any[]>('SELECT day_of_week, is_closed, open_time, close_time, last_booking_offset_mins FROM business_hours WHERE store_id = ? ORDER BY day_of_week', [storeId]),
    db.query<any[]>(
      `SELECT booking_date, slot, COUNT(*) AS booked FROM bookings
       WHERE store_id = ? AND booking_date BETWEEN ? AND ?
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY booking_date, slot`,
      [storeId, firstDay, lastDay],
    ),
  ])

  const hoistCount = Number(hoistResult[0][0]?.hoist_count ?? 0)
  function toMins(t: string) { const [h,m] = t.slice(0,5).split(':').map(Number); return h*60+m }
  const MORNING_MINS   = toMins('09:00')
  const AFTERNOON_MINS = toMins('13:00')

  const closedDays = new Set<number>(), noMorningDays = new Set<number>(), noAfternoonDays = new Set<number>()
  for (const row of hoursResult[0]) {
    const dow = Number(row.day_of_week)
    if (row.is_closed) { closedDays.add(dow); continue }
    if (row.open_time && row.close_time) {
      const openMins        = toMins(row.open_time)
      const lastBookingMins = toMins(row.close_time) - Number(row.last_booking_offset_mins ?? 0)
      if (MORNING_MINS   < openMins || MORNING_MINS   > lastBookingMins) noMorningDays.add(dow)
      if (AFTERNOON_MINS < openMins || AFTERNOON_MINS > lastBookingMins) noAfternoonDays.add(dow)
    }
  }
  const hasHours = hoursResult[0].length > 0
  const closureDates = new Set<string>(store.closure_dates ? (typeof store.closure_dates === 'string' ? JSON.parse(store.closure_dates) : store.closure_dates) : [])

  const bookingCounts = new Map<string, number>()
  for (const row of bookingsResult[0]) {
    const d = row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : String(row.booking_date).slice(0, 10)
    bookingCounts.set(`${d}|${row.slot}`, Number(row.booked))
  }

  const today  = new Date().toISOString().slice(0, 10)
  const days: Record<string, { open: boolean; morning: number; afternoon: number }> = {}
  const cursor = new Date(`${firstDay}T00:00:00`)
  const end    = new Date(`${lastDay}T00:00:00`)

  while (cursor <= end) {
    const dateStr  = cursor.toISOString().slice(0, 10)
    const jsDow    = cursor.getDay()
    const isoDow   = jsDow === 0 ? 6 : jsDow - 1
    const isPast   = dateStr <= today
    const isClosed = closureDates.has(dateStr) || (hasHours ? closedDays.has(isoDow) : false)

    if (isPast || isClosed) {
      days[dateStr] = { open: false, morning: 0, afternoon: 0 }
    } else {
      days[dateStr] = {
        open:      true,
        morning:   (hasHours && noMorningDays.has(isoDow))   ? 0 : Math.max(0, hoistCount - (bookingCounts.get(`${dateStr}|morning`)   ?? 0)),
        afternoon: (hasHours && noAfternoonDays.has(isoDow)) ? 0 : Math.max(0, hoistCount - (bookingCounts.get(`${dateStr}|afternoon`) ?? 0)),
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }

  return { storeName: store.name, storeId, month, days }
}

function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function createBooking(
  db: mysql.Pool,
  customerId: number,
  vehicleId: number,
  storeId: number,
  date: string,
  slot: 'morning' | 'afternoon',
  type: 'drop_off' | 'wait' | 'pickup',
  serviceTypeIds: number[],
  notes?: string,
): Promise<object> {
  const [[store]] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
  if (!store) return { error: 'Store not found' }

  const [[vehicle]] = await db.query<any[]>(
    `SELECT v.id FROM vehicles v JOIN vehicle_owners vo ON vo.vehicle_id = v.id
     WHERE v.id = ? AND vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1 LIMIT 1`,
    [vehicleId, customerId],
  )
  if (!vehicle) return { error: 'Vehicle not found' }

  const today = new Date().toISOString().slice(0, 10)
  if (date < today) return { error: 'Date must be in the future' }

  const [stRows] = await db.query<any[]>(
    `SELECT id FROM service_types WHERE id IN (${serviceTypeIds.map(() => '?').join(',')}) AND is_active = 1`,
    serviceTypeIds,
  )
  if (stRows.length !== serviceTypeIds.length) return { error: 'One or more service types are invalid' }

  const [result] = await db.query<any>(
    `INSERT INTO bookings (store_id, booking_ref, customer_id, vehicle_id, booking_date, booking_time, slot, drop_off_type, customer_notes, status, booking_source)
     VALUES (?, ?, ?, ?, ?, '00:00:00', ?, ?, ?, 'pending', 'rodz_app')`,
    [storeId, generateBookingRef(), customerId, vehicleId, date, slot, type, notes ?? null],
  )
  const bookingId = result.insertId

  if (serviceTypeIds.length) {
    const vals = serviceTypeIds.map(() => '(?,?)').join(',')
    const args = serviceTypeIds.flatMap((id: number) => [bookingId, id])
    await db.query(`INSERT INTO booking_services (booking_id, service_type_id) VALUES ${vals}`, args)
  }

  const [[booking]] = await db.query<any[]>(
    `SELECT b.booking_ref, b.booking_date, b.slot, b.status, s.name AS store_name
     FROM bookings b JOIN stores s ON s.id = b.store_id WHERE b.id = ? LIMIT 1`,
    [bookingId],
  )
  const date_ = booking.booking_date instanceof Date ? booking.booking_date.toISOString().slice(0, 10) : String(booking.booking_date).slice(0, 10)

  return {
    bookingId,
    bookingRef:  booking.booking_ref,
    date:        date_,
    slot:        booking.slot,
    status:      booking.status,
    store:       booking.store_name,
    confirmed:   true,
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'checkAvailability',
      description: 'Check available booking slots at a Rodz workshop for a given month. Call this before suggesting specific dates to the customer.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId: { type: SchemaType.NUMBER, description: 'The store ID (1 = Rodz Somerville)' },
          month:   { type: SchemaType.STRING, description: 'Month in YYYY-MM format, e.g. "2026-07"' },
        },
        required: ['storeId', 'month'],
      },
    },
    {
      name: 'getServiceTypes',
      description: 'Get the list of services available at Rodz workshops so you can present options to the customer and collect the correct service IDs for booking.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {},
      },
    },
    {
      name: 'bookAppointment',
      description: 'Book a service appointment at a Rodz workshop for the customer. Only call this after confirming the date, slot, store, and services with the customer.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId:        { type: SchemaType.NUMBER, description: 'Store ID' },
          date:           { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
          slot:           { type: SchemaType.STRING, format: 'enum', enum: ['morning', 'afternoon'], description: 'Morning or afternoon' },
          type:           { type: SchemaType.STRING, format: 'enum', enum: ['drop_off', 'wait', 'pickup'], description: 'How the customer will drop the car off' },
          serviceTypeIds: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER }, description: 'Array of service type IDs to book' },
          notes:          { type: SchemaType.STRING, description: 'Optional notes from the customer' },
        },
        required: ['storeId', 'date', 'slot', 'type', 'serviceTypeIds'],
      },
    },
  ],
}]

export const handler = awslambda.streamifyResponse(async (event: any, responseStream: any, _context: any) => {
  await ready

  const corsHeaders = {
    'Content-Type':                  'text/event-stream',
    'Cache-Control':                 'no-cache',
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Allow-Headers':  'Authorization, Content-Type',
    'Access-Control-Allow-Methods':  'POST, OPTIONS',
  }

  // Handle CORS preflight
  if (event.requestContext?.http?.method === 'OPTIONS') {
    const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: 204, headers: corsHeaders })
    out.end()
    return
  }

  // Validate JWT manually (no API Gateway authorizer on Function URL)
  const authHeader: string = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  let customerId: number
  try {
    if (!token) throw new Error('No token')
    const payload = jwt.verify(token, JWT_SECRET) as any
    if (payload.type !== 'customer') throw new Error('Wrong token type')
    customerId = Number(payload.sub)
  } catch {
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
    out.write(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token.' } }))
    out.end()
    return
  }

  const vehicleId = Number(event.pathParameters?.id ?? (event.rawPath ?? '').split('/').at(-2))

  const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: corsHeaders })

  const db = getPool()

  try {
    // Ownership check
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, customerId],
    )
    if (!ownership) {
      sse(out, { type: 'error', code: 'FORBIDDEN', message: 'Vehicle not found.' })
      out.end()
      return
    }

    const body     = JSON.parse(event.body ?? '{}')
    const content  = body.content ? String(body.content).trim() : null
    const imageId  = body.imageId ? String(body.imageId) : null

    if (!content && !imageId) {
      sse(out, { type: 'error', code: 'VALIDATION_ERROR', message: 'content or imageId is required.' })
      out.end()
      return
    }

    // Save user message
    const [userInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, role, content, image_id) VALUES (?,?,?,?,?)',
      [vehicleId, customerId, 'user', content, imageId],
    )
    const userMessageId = userInsert.insertId

    sse(out, { type: 'user_message_id', id: userMessageId })

    // Build context and history in parallel
    const [vehicleContext, historyResult] = await Promise.all([
      buildCustomerVehicleContext(db, vehicleId),
      db.query<any[]>(
        `SELECT role, content, image_id FROM customer_vehicle_chats
         WHERE vehicle_id = ? AND customer_id = ? AND id < ?
         ORDER BY id ASC LIMIT 40`,
        [vehicleId, customerId, userMessageId],
      ),
    ])

    const today = new Date().toISOString().slice(0, 10)
    const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', today, vehicleContext })}
${ASSISTANT_IDENTITY}
${ASSISTANT_VALUES}
${ASSISTANT_WORKSHOP_FRAMING}

## Booking flow
1. First use checkAvailability to check what slots are open for the requested timeframe
2. Present the available dates clearly (e.g. "Tuesday 8th July — morning or afternoon available")
3. Ask what services they need (use getServiceTypes to get the list)
4. Confirm everything with them before calling bookAppointment
5. After booking, confirm with their booking reference number

${ASSISTANT_DIAGNOSIS_FLOW}
${ASSISTANT_SAFETY_RAILS}

Keep responses conversational and concise. Use markdown for lists or emphasis where it helps readability.`

    // Build history for Gemini
    const historyRows: any[] = historyResult[0]
    const contents: Content[] = []
    for (const msg of historyRows) {
      const parts: Part[] = []
      if (msg.content) parts.push({ text: msg.content })
      else if (msg.image_id) parts.push({ text: '[Image attached]' })
      if (parts.length) contents.push({ role: msg.role === 'model' ? 'model' : 'user', parts })
    }

    // Current user message parts
    const userParts: Part[] = []
    if (content) userParts.push({ text: content })
    if (imageId) {
      try {
        const { base64, mimeType } = await fetchImageAsBase64(imageId)
        userParts.push({ inlineData: { mimeType, data: base64 } })
      } catch {
        userParts.push({ text: '[Image could not be loaded]' })
      }
    }
    contents.push({ role: 'user', parts: userParts })

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      tools:             TOOLS,
      generationConfig:  {
        // @ts-ignore — thinkingConfig not yet in type definitions
        thinkingConfig: { thinkingBudget: 0 },
      },
    })

    let fullResponse = ''
    let loopCount    = 0
    const MAX_LOOPS  = 5 // limit function call rounds

    while (loopCount < MAX_LOOPS) {
      loopCount++
      const stream = await model.generateContentStream({ contents })

      let functionCallPart: any = null
      let chunkText = ''

      for await (const chunk of stream.stream) {
        const candidate = chunk.candidates?.[0]
        if (!candidate) continue

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            chunkText += part.text
            fullResponse += part.text
            sse(out, { type: 'chunk', text: part.text })
          } else if (part.functionCall) {
            functionCallPart = part.functionCall
          }
        }
      }

      // If no function call, we're done
      if (!functionCallPart) break

      // Execute the function call
      const { name, args } = functionCallPart
      sse(out, { type: 'function_call', name, args })

      let fnResult: object
      if (name === 'checkAvailability') {
        fnResult = await checkAvailability(db, Number(args.storeId), String(args.month))
      } else if (name === 'getServiceTypes') {
        const [rows] = await db.query<any[]>(
          `SELECT id, name, category, description, fixed_price, labour_hours_estimate
           FROM service_types WHERE is_active = 1 ORDER BY sort_order, name`,
        )
        fnResult = { services: rows.map((r: any) => ({
          id:          r.id,
          name:        r.name,
          category:    r.category,
          description: r.description ?? null,
          fixedPrice:  r.fixed_price ? Number(r.fixed_price) : null,
          estimatedHours: Number(r.labour_hours_estimate),
        }))}
      } else if (name === 'bookAppointment') {
        fnResult = await createBooking(
          db, customerId, vehicleId,
          Number(args.storeId), String(args.date),
          args.slot as 'morning' | 'afternoon',
          (args.type as 'drop_off' | 'wait' | 'pickup') ?? 'drop_off',
          (args.serviceTypeIds as number[]) ?? [],
          args.notes ? String(args.notes) : undefined,
        )
      } else {
        fnResult = { error: `Unknown function: ${name}` }
      }

      sse(out, { type: 'function_result', name, result: fnResult })

      // Feed result back into conversation
      if (chunkText) {
        contents.push({ role: 'model', parts: [{ text: chunkText }, { functionCall: functionCallPart }] })
      } else {
        contents.push({ role: 'model', parts: [{ functionCall: functionCallPart }] })
      }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: fnResult } }] })
    }

    // Save the complete model response
    const [modelInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, role, content) VALUES (?,?,?,?)',
      [vehicleId, customerId, 'model', fullResponse || null],
    )

    sse(out, { type: 'done', messageId: modelInsert.insertId })
  } catch (err: any) {
    sse(out, { type: 'error', code: 'SERVER_ERROR', message: err?.message ?? 'Unknown error' })
  } finally {
    out.end()
  }
})
