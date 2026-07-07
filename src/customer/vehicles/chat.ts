import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type { Content } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'
import { classifyIntent } from '../agents/intent'
import type { AgentContext } from '../agents/types'
import * as bookingAgent  from '../agents/booking'
import * as vehicleAgent  from '../agents/vehicle'
import * as expenseAgent  from '../agents/expense'
import * as fuelAgent     from '../agents/fuel'
import * as logbookAgent  from '../agents/logbook-agent'

const ready   = bootstrap()
const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

let toolCallsColumnReady = false
async function ensureToolCallsColumn(db: mysql.Pool): Promise<void> {
  if (toolCallsColumnReady) return
  try { await db.query('ALTER TABLE customer_vehicle_chats ADD COLUMN tool_calls JSON NULL') } catch {}
  toolCallsColumnReady = true
}

async function fetchImageAsBase64(imageId: string): Promise<{ base64: string; mimeType: string }> {
  const url  = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const base64   = Buffer.from(await res.arrayBuffer()).toString('base64')
  return { base64, mimeType }
}

async function buildVehicleContext(db: mysql.Pool, vehicleId: number): Promise<{ context: string; rego: string }> {
  const [[v]] = await db.query<any[]>(
    `SELECT v.make, v.model, v.year, v.series, v.rego, v.rego_state, v.fuel_type, v.transmission,
            v.engine_code, v.engine_size_cc, v.cylinders, v.body_type, v.colour,
            v.tyre_size_front, v.tyre_size_rear, v.odometer_current,
            v.next_service_due_km, v.next_service_due_date,
            v.service_interval_km, v.service_interval_months
     FROM vehicles v WHERE v.id = ? AND v.is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return { context: '', rego: '' }

  const lines: string[] = [
    `## Your Vehicle`,
    `${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}`,
    `Rego: ${v.rego} ${v.rego_state}`,
    `Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}`,
  ]
  if (v.colour)           lines.push(`Colour: ${v.colour}`)
  if (v.odometer_current) lines.push(`Current odometer: ${Number(v.odometer_current).toLocaleString()} km`)
  if (v.engine_code)      lines.push(`Engine: ${v.engine_code}${v.engine_size_cc ? ` ${v.engine_size_cc}cc` : ''}${v.cylinders ? ` ${v.cylinders}-cyl` : ''}`)
  if (v.tyre_size_front)  lines.push(`Tyres: ${v.tyre_size_front}${v.tyre_size_rear && v.tyre_size_rear !== v.tyre_size_front ? ` front / ${v.tyre_size_rear} rear` : ''}`)
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

  const [logs] = await db.query<any[]>(
    `SELECT vsl.service_date, COALESCE(i.odometer_in, vsl.odometer) AS odometer,
            vsl.store, vsl.total, vsl.ai_summary
     FROM vehicle_service_log vsl
     LEFT JOIN invoices i ON i.id = vsl.invoice_id
     WHERE vsl.vehicle_rego = ?
     ORDER BY vsl.service_date DESC LIMIT 8`,
    [v.rego],
  )
  if (logs.length) {
    lines.push('', '## Service History (most recent first)')
    for (const job of logs) {
      const date    = job.service_date instanceof Date ? job.service_date.toISOString().slice(0, 10) : String(job.service_date).slice(0, 10)
      const odo     = job.odometer ? ` @ ${Number(job.odometer).toLocaleString()} km` : ''
      const summary = job.ai_summary ? `: ${job.ai_summary.split('.')[0]}` : ''
      lines.push(`${date}${odo} — $${Number(job.total).toFixed(0)} at ${job.store ?? 'Rodz'}${summary}`)
    }
  }

  return { context: lines.join('\n'), rego: v.rego }
}

function buildHistory(rows: any[]): Content[] {
  const contents: Content[] = []
  for (const msg of rows) {
    if (msg.role === 'model' && msg.tool_calls) {
      const toolCalls: { name: string; args: any; result: any }[] = typeof msg.tool_calls === 'string'
        ? JSON.parse(msg.tool_calls)
        : msg.tool_calls
      for (const tc of toolCalls) {
        contents.push({ role: 'model', parts: [{ functionCall: { name: tc.name, args: tc.args } }] })
        contents.push({ role: 'user',  parts: [{ functionResponse: { name: tc.name, response: tc.result } }] })
      }
      if (msg.content) contents.push({ role: 'model', parts: [{ text: msg.content }] })
    } else {
      const parts: any[] = []
      if (msg.content)  parts.push({ text: msg.content })
      else if (msg.image_id) parts.push({ text: '[Image attached]' })
      if (parts.length) contents.push({ role: msg.role === 'model' ? 'model' : 'user', parts })
    }
  }
  return contents
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    await ensureToolCallsColumn(db)

    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const body    = JSON.parse(event.body ?? '{}')
    const content = body.content ? String(body.content).trim() : null
    const imageId = body.imageId ? String(body.imageId) : null
    if (!content && !imageId) return validationError('content or imageId is required')

    const [userInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, role, content, image_id) VALUES (?,?,?,?,?)',
      [vehicleId, ctx.customerId, 'user', content, imageId],
    )
    const userMessageId = userInsert.insertId

    // Build all context in parallel
    const [vehicleResult, historyResult, customerResult] = await Promise.all([
      buildVehicleContext(db, vehicleId),
      db.query<any[]>(
        `SELECT role, content, image_id, tool_calls FROM customer_vehicle_chats
         WHERE vehicle_id = ? AND customer_id = ? AND id < ?
         ORDER BY id ASC LIMIT 40`,
        [vehicleId, ctx.customerId, userMessageId],
      ),
      db.query<any[]>(
        'SELECT first_name, suburb, state, is_premium FROM customers WHERE id = ? LIMIT 1',
        [ctx.customerId],
      ),
    ])

    const customer    = customerResult[0][0]
    const isPremium   = !!customer?.is_premium
    const message     = content ?? '[Image]'

    const agentCtx: AgentContext = {
      db,
      customerId:        ctx.customerId,
      vehicleId,
      vehicleRego:       vehicleResult.rego,
      customerFirstName: customer?.first_name ?? null,
      customerSuburb:    customer?.suburb ?? null,
      customerState:     customer?.state ?? null,
      isPremium,
      vehicleContext:    vehicleResult.context,
      history:           buildHistory(historyResult[0]),
      today:             new Date().toISOString().slice(0, 10),
    }

    // Route to the appropriate specialist agent
    const intent = classifyIntent(message, isPremium)

    let imageData: { data: string; mimeType: string } | undefined
    if (imageId) {
      try { imageData = await fetchImageAsBase64(imageId).then(r => ({ data: r.base64, mimeType: r.mimeType })) } catch {}
    }

    let agentResult
    if (intent === 'booking') {
      agentResult = await bookingAgent.run(agentCtx, message)
    } else if (intent === 'expense') {
      agentResult = await expenseAgent.run(agentCtx, message)
    } else if (intent === 'fuel') {
      agentResult = await fuelAgent.run(agentCtx, message)
    } else if (intent === 'logbook') {
      agentResult = await logbookAgent.run(agentCtx, message)
    } else {
      agentResult = await vehicleAgent.run(agentCtx, message, imageData)
    }

    const toolCallsJson = agentResult.functionCalls.length ? JSON.stringify(agentResult.functionCalls) : null
    const [modelInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, role, content, tool_calls) VALUES (?,?,?,?,?)',
      [vehicleId, ctx.customerId, 'model', agentResult.content || null, toolCallsJson],
    )

    return ok({
      userMessageId,
      messageId:     modelInsert.insertId,
      content:       agentResult.content,
      agent:         intent,
      functionCalls: agentResult.functionCalls.length ? agentResult.functionCalls.map(({ name, result }) => ({ name, result })) : undefined,
    })
  } catch (err) {
    return serverError(err)
  }
}
