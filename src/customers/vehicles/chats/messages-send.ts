import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import mysql from 'mysql2/promise'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'

const ready = bootstrap()

async function fetchImageAsBase64(imageId: string): Promise<{ base64: string; mimeType: string }> {
  const hash = process.env.CF_ACCOUNT_HASH ?? ''
  const url  = `https://imagedelivery.net/${hash}/${imageId}/public`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const base64   = Buffer.from(await res.arrayBuffer()).toString('base64')
  return { base64, mimeType }
}

async function buildVehicleContext(db: mysql.Pool, vehicleId: string): Promise<string> {
  const [[v]] = await db.query<any[]>(
    `SELECT make, model, year, series, rego, rego_state, fuel_type, transmission,
            engine_code, engine_size_cc, cylinders, body_type, colour,
            tyre_size_front, tyre_size_rear,
            service_interval_km, service_interval_months
     FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return ''

  const lines: string[] = [
    '## Vehicle',
    `${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}`,
    `Rego: ${v.rego} ${v.rego_state}`,
    `Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}`,
  ]
  if (v.engine_code)  lines.push(`Engine code: ${v.engine_code}`)
  if (v.engine_size_cc) lines.push(`Engine size: ${v.engine_size_cc}cc`)
  if (v.cylinders)    lines.push(`Cylinders: ${v.cylinders}`)
  if (v.body_type)    lines.push(`Body: ${v.body_type}`)
  if (v.colour)       lines.push(`Colour: ${v.colour}`)
  if (v.tyre_size_front) lines.push(`Tyres: ${v.tyre_size_front}${v.tyre_size_rear && v.tyre_size_rear !== v.tyre_size_front ? ` front / ${v.tyre_size_rear} rear` : ''}`)
  if (v.service_interval_km) lines.push(`Service interval: every ${Number(v.service_interval_km).toLocaleString()} km${v.service_interval_months ? ` or ${v.service_interval_months} months` : ''}`)

  // Vehicle model profile (AI-generated technical reference)
  const [[profile]] = await db.query<any[]>(
    `SELECT overview, engine_specs, tyre_specs, service_notes, known_issues, common_repairs
     FROM vehicle_model_profiles WHERE make = ? AND model = ? AND year = ? LIMIT 1`,
    [v.make, v.model, v.year],
  )

  if (profile) {
    lines.push('', '## Technical Reference')
    if (profile.overview) lines.push(profile.overview)

    const specs = typeof profile.engine_specs === 'string' ? JSON.parse(profile.engine_specs) : profile.engine_specs
    if (specs) {
      if (specs.oilType)       lines.push(`Oil: ${specs.oilType}${specs.oilCapacityL ? ` (${specs.oilCapacityL}L with filter)` : ''}`)
      if (specs.coolantType)   lines.push(`Coolant: ${specs.coolantType}`)
      if (specs.brakeFluid)    lines.push(`Brake fluid: ${specs.brakeFluid}`)
      if (specs.transmissionFluid) lines.push(`Trans fluid: ${specs.transmissionFluid}`)
      if (specs.timingDrive)   lines.push(`Timing: ${specs.timingDrive}${specs.timingBeltIntervalKm ? ` — belt interval ${Number(specs.timingBeltIntervalKm).toLocaleString()} km` : ''}`)
      if (specs.sparkPlugType) lines.push(`Spark plugs: ${specs.sparkPlugType}${specs.sparkPlugIntervalKm ? ` — ${Number(specs.sparkPlugIntervalKm).toLocaleString()} km interval` : ''}`)
    }

    const notes = typeof profile.service_notes === 'string' ? JSON.parse(profile.service_notes) : profile.service_notes
    if (Array.isArray(notes) && notes.length) {
      lines.push('', 'Service notes:')
      notes.forEach((n: string) => lines.push(`- ${n}`))
    }

    const issues = typeof profile.known_issues === 'string' ? JSON.parse(profile.known_issues) : profile.known_issues
    if (Array.isArray(issues) && issues.length) {
      lines.push('', 'Known issues:')
      issues.forEach((i: any) => lines.push(`- [${i.severity}] ${i.title}: ${i.description}`))
    }
  }

  // Service history (last 10 jobs)
  const [jobs] = await db.query<any[]>(
    `SELECT j.id, j.job_number, b.booking_date, j.odometer_in, j.status,
            GROUP_CONCAT(DISTINCT st.name ORDER BY st.name SEPARATOR ', ') AS services
     FROM service_jobs j
     JOIN bookings b ON b.id = j.booking_id
     LEFT JOIN booking_services bs ON bs.booking_id = j.booking_id
     LEFT JOIN service_types st ON st.id = bs.service_type_id
     WHERE j.vehicle_id = ?
     GROUP BY j.id, j.job_number, b.booking_date, j.odometer_in, j.status
     ORDER BY b.booking_date DESC
     LIMIT 10`,
    [vehicleId],
  )

  if (jobs.length) {
    lines.push('', '## Service History (most recent first)')
    for (const j of jobs) {
      const date = j.booking_date instanceof Date
        ? j.booking_date.toISOString().slice(0, 10)
        : String(j.booking_date).slice(0, 10)
      const odo = j.odometer_in ? ` @ ${Number(j.odometer_in).toLocaleString()} km` : ''
      lines.push(`${date} — Job #${j.job_number}${odo}: ${j.services ?? 'No services listed'} [${j.status}]`)
    }
  }

  // Parts history (last 20 parts)
  const [parts] = await db.query<any[]>(
    `SELECT sjp.description, sjp.part_number, sjp.qty, sjp.status, b.booking_date
     FROM service_job_parts sjp
     JOIN service_jobs j ON j.id = sjp.service_job_id
     JOIN bookings b ON b.id = j.booking_id
     WHERE j.vehicle_id = ?
     ORDER BY b.booking_date DESC
     LIMIT 20`,
    [vehicleId],
  )

  if (parts.length) {
    lines.push('', '## Parts History')
    for (const p of parts) {
      const date = p.booking_date instanceof Date
        ? p.booking_date.toISOString().slice(0, 10)
        : String(p.booking_date).slice(0, 10)
      const pn = p.part_number ? ` (${p.part_number})` : ''
      lines.push(`${date} — ${p.description}${pn} × ${p.qty} [${p.status}]`)
    }
  }

  return lines.join('\n')
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId, chatId } = event.pathParameters ?? {}

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicle) return notFound('Vehicle')

    if (ctx.role !== 'super_admin') {
      const [[customer]] = await db.query<any[]>(
        'SELECT store_id FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customer?.store_id !== ctx.storeId) return notFound('Vehicle')
    }

    const [[chat]] = await db.query<any[]>(
      'SELECT id FROM vehicle_chats WHERE id = ? AND vehicle_id = ? LIMIT 1',
      [chatId, vehicleId],
    )
    if (!chat) return notFound('Chat')

    const body    = JSON.parse(event.body ?? '{}') as Record<string, any>
    const content = body.content ? String(body.content).trim() : null
    const imageId = body.imageId ? String(body.imageId) : null

    if (!content && !imageId) return validationError('content or imageId is required.')

    // Build vehicle context and load conversation history in parallel
    const [vehicleContext, historyResult] = await Promise.all([
      buildVehicleContext(db, vehicleId!),
      db.query<any[]>(
        `SELECT role, content, image_id
         FROM vehicle_chat_messages
         WHERE chat_id = ?
         ORDER BY id ASC
         LIMIT 40`,
        [chatId],
      ),
    ])

    const historyRows: any[] = historyResult[0]

    const systemInstruction = `You are an expert automotive technician assistant working at an Australian workshop called Rodz. You have access to the complete history and technical specifications of the vehicle below. Use this to give accurate, specific advice to the mechanic.

${vehicleContext}

Keep responses concise and practical. Flag anything safety-critical first. When discussing costs, use Australian dollars. Speak to a qualified mechanic — avoid explaining basic automotive concepts unless asked.`

    // Build Gemini contents from history
    // For historical image messages, substitute a text note — the model's prior response provides context
    const contents: any[] = []
    for (const msg of historyRows) {
      const parts: any[] = []
      if (msg.content) parts.push({ text: msg.content })
      if (msg.image_id && !msg.content) parts.push({ text: '[Image attached]' })
      if (parts.length) {
        contents.push({ role: msg.role === 'model' ? 'model' : 'user', parts })
      }
    }

    // Build new user message parts — include actual image data for current message
    const newParts: any[] = []
    if (imageId) {
      const imageData = await fetchImageAsBase64(imageId)
      newParts.push({ inlineData: { data: imageData.base64, mimeType: imageData.mimeType } })
    }
    if (content) {
      newParts.push({ text: content })
    }
    contents.push({ role: 'user', parts: newParts })

    const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction })
    const result = await model.generateContent({ contents })
    const reply  = result.response.text()

    // Save user message then assistant reply
    await db.query(
      `INSERT INTO vehicle_chat_messages (chat_id, role, content, image_id, staff_id, created_at)
       VALUES (?, 'user', ?, ?, ?, NOW())`,
      [chatId, content, imageId, ctx.staffId],
    )

    const [ins] = await db.query<any>(
      `INSERT INTO vehicle_chat_messages (chat_id, role, content, image_id, staff_id, created_at)
       VALUES (?, 'model', ?, NULL, NULL, NOW())`,
      [chatId, reply],
    )

    return ok({ messageId: ins.insertId, reply })
  } catch (err) {
    return serverError(err)
  }
}
