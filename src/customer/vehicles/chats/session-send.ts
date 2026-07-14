import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI, Part, Content, SchemaType, Tool } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, getCustomerTier } from '../../_helpers'
import { classifyIntent } from '../../agents/intent'
import type { AgentContext } from '../../agents/types'
import * as expenseAgent  from '../../agents/expense'
import * as fuelAgent     from '../../agents/fuel'
import * as logbookAgent  from '../../agents/logbook-agent'
import {
  getAssistantMemory, saveAssistantMemory, forgetAssistantMemory,
  renderMemoryBlock, isMemoryEnabled,
  extractHints, isHintsEnabled, HINTS_INSTRUCTION,
} from './_shared'
import { readFromDataLake } from '../../../shared/dataLake'
import { loadSession, appendMessages } from './messagesStore'
import { safeIncr } from '../../../shared/redis'
import { getCachedVehicleContext } from './_grounding'
import {
  BOOKING_TOOL_DECLARATIONS,
  checkAvailability, checkTimeSlots, checkCourtesyCars,
  getVehicleValue, getServiceTypes, createBooking,
} from './_tools'
import type mysql from 'mysql2/promise'

// Rate limit tiers — messages per customer per calendar day.
const RATE_LIMIT_BY_TIER: Record<string, number> = { free: 20, silver: 100, gold: 100 }
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED === 'true'

const ready = bootstrap()

const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

async function fetchImageAsBase64(imageId: string): Promise<{ base64: string; mimeType: string }> {
  const url  = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const base64   = Buffer.from(await res.arrayBuffer()).toString('base64')
  return { base64, mimeType }
}


async function generateSessionTitle(db: mysql.Pool, sessionId: number, firstMessage: string): Promise<void> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } } as any,
  })
  const result = await model.generateContent(
    `Generate a 3-5 word title for a vehicle support chat that starts with this message. Return only the title, no punctuation, no quotes:\n\n"${firstMessage.slice(0, 300)}"`,
  )
  const title = result.response.text().trim().slice(0, 100)
  if (title) await db.query('UPDATE customer_chat_sessions SET title = ? WHERE id = ?', [title, sessionId])
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    ...BOOKING_TOOL_DECLARATIONS,
    {
      name: 'getFuelSummary',
      description: 'Get pre-computed fuel aggregates for this vehicle (last fill, YTD spend, litres, avg consumption). Use this for questions like "how much have I spent on fuel this year?" — do NOT list every fill.',
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
      name: 'getExpenseSummary',
      description: 'Get pre-computed expense aggregates for this vehicle (MTD, YTD, per-category YTD, cost per km). Use this for "how much have I spent" style questions.',
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
      name: 'getFuelHistory',
      description: 'Fetch detailed recent fuel-fill records (litres, price, station, odometer). Use only when the customer asks for a specific list or breakdown — otherwise prefer getFuelSummary.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: { limit: { type: SchemaType.NUMBER, description: 'How many most-recent fills to return. Default 10, max 30.' } },
      },
    },
    {
      name: 'getExpenseHistory',
      description: 'Fetch detailed recent expense records (amount, category, merchant, date). Use only for specific list/breakdown requests — otherwise prefer getExpenseSummary.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit:  { type: SchemaType.NUMBER, description: 'How many most-recent expenses to return. Default 10, max 30.' },
          months: { type: SchemaType.NUMBER, description: 'Restrict to the last N months. Default 12.' },
        },
      },
    },
    {
      name: 'getDiagnosticHistory',
      description: "List the customer's previous chat sessions with this vehicle. Returns each session's id, title, and date — NOT the messages themselves. Use for 'what did we talk about last time' style questions. If the customer wants details of a specific past conversation, then call getSessionMessages with the sessionId.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: { limit: { type: SchemaType.NUMBER, description: 'How many most-recent sessions to return. Default 10, max 25.' } },
      },
    },
    {
      name: 'getSessionMessages',
      description: 'Fetch the actual messages from a specific past chat session (identified by sessionId returned by getDiagnosticHistory). Use only when the customer asks about a specific past conversation. Returns the last N messages of that session.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          sessionId: { type: SchemaType.NUMBER, description: 'The session id from getDiagnosticHistory.' },
          limit:     { type: SchemaType.NUMBER, description: 'How many most-recent messages of that session to return. Default 20, max 50.' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'remember',
      description: "Save a short note about this vehicle so you can reference it in future conversations. Use this only for genuinely useful context the customer would appreciate you remembering later — running symptoms, personal preferences (e.g. always books morning slots), things they mentioned they're planning. Do NOT use for facts already in the logbook or vehicle specs.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          note:          { type: SchemaType.STRING,  description: "The note, first-person from the assistant's perspective. Max 500 chars." },
          expiresInDays: { type: SchemaType.NUMBER, description: 'How long to remember. Default 180. Use 30 for short-term follow-ups, 365 for long-lived preferences.' },
        },
        required: ['note'],
      },
    },
    {
      name: 'forget',
      description: "Remove a memory note when it's no longer relevant (e.g. the issue was resolved).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          noteId: { type: SchemaType.NUMBER },
        },
        required: ['noteId'],
      },
    },
  ],
}]

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    const body    = JSON.parse(event.body ?? '{}')
    const content = body.content ? String(body.content).trim() : null
    const imageId = body.imageId ? String(body.imageId) : null

    if (!content && !imageId) return validationError('content or imageId is required')

    // Rate limit — per-customer per-day counter in Redis. safeIncr returns 0
    // on Redis failure → fail-open (request goes through).
    if (RATE_LIMIT_ENABLED) {
      const today = new Date().toISOString().slice(0, 10)
      const count = await safeIncr(`ratelimit:${ctx.customerId}:${today}`, 86400)
      if (count > 0) {
        const tier   = await getCustomerTier(db, ctx.customerId)
        const limit  = RATE_LIMIT_BY_TIER[tier] ?? RATE_LIMIT_BY_TIER.free
        if (count > limit) {
          const resetsAt = new Date()
          resetsAt.setUTCHours(24, 0, 0, 0)
          return {
            statusCode: 429,
            headers:    { 'Content-Type': 'application/json' },
            body:       JSON.stringify({
              error:    'RATE_LIMIT',
              message:  `Daily message limit of ${limit} reached.`,
              resetsAt: resetsAt.toISOString(),
            }),
          }
        }
      }
    }

    // Load the session blob from S3 (or empty if new). This gives us the
    // current message history + whether this is the first user turn.
    const { blob: existingBlob } = await loadSession(sessionId)
    const priorMessages = existingBlob?.messages ?? []
    const isFirstMessage = priorMessages.length === 0

    // Append the user message to S3 up front so if Gemini fails, the user's
    // input is not lost.
    const [savedUserMsg] = await appendMessages(sessionId, vehicleId, ctx.customerId, [{
      role: 'user', content, imageId: imageId ?? null,
    }])
    const userMessageId = savedUserMsg.id

    const [vehicleContext, customerResult, vehicleRegoResult, memory] = await Promise.all([
      getCachedVehicleContext(db, vehicleId),
      db.query<any[]>('SELECT first_name, gender, suburb, state, is_premium FROM customers WHERE id = ? LIMIT 1', [ctx.customerId])
        .catch(() => [[]] as [any[]]),
      db.query<any[]>('SELECT rego FROM vehicles WHERE id = ? LIMIT 1', [vehicleId]),
      getAssistantMemory(db, vehicleId),
    ])

    const customer          = customerResult[0][0]
    const customerFirstName = customer?.first_name ?? null
    const isPremium         = !!customer?.is_premium
    const vehicleRego       = (vehicleRegoResult[0] as any[])[0]?.rego ?? ''
    const assistantName     = 'Rodz'
    const today             = new Date().toISOString().slice(0, 10)

    // Build history Content[] from the S3 blob (last 40 messages before the
    // one we just appended). Shared by specialist agents and the main
    // Gemini handler.
    const historyForContext = priorMessages.slice(-40)
    const historyContents: Content[] = []
    for (const msg of historyForContext) {
      if (msg.role === 'model' && msg.toolCalls) {
        const toolCalls: Array<{ name: string; args: any; result: any }> = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
        for (const tc of toolCalls) {
          historyContents.push({ role: 'model', parts: [{ functionCall: { name: tc.name, args: tc.args } }] })
          historyContents.push({ role: 'user',  parts: [{ functionResponse: { name: tc.name, response: tc.result } }] })
        }
        if (msg.content) historyContents.push({ role: 'model', parts: [{ text: msg.content }] })
      } else {
        const parts: Part[] = []
        if (msg.content) parts.push({ text: msg.content })
        else if (msg.imageId) parts.push({ text: '[Image attached]' })
        if (parts.length) historyContents.push({ role: msg.role === 'model' ? 'model' : 'user', parts })
      }
    }

    // Route expense / fuel / logbook messages to specialist agents
    const intent = classifyIntent(content ?? '', isPremium)
    if (content && (intent === 'expense' || intent === 'fuel' || intent === 'logbook')) {
      const agentCtx: AgentContext = {
        db,
        customerId:        ctx.customerId,
        vehicleId,
        vehicleRego,
        customerFirstName,
        customerSuburb:    customer?.suburb ?? null,
        customerState:     customer?.state ?? null,
        isPremium,
        vehicleContext,
        history:           historyContents,
        today,
      }

      const agentResult = intent === 'expense'
        ? await expenseAgent.run(agentCtx, content)
        : intent === 'fuel'
          ? await fuelAgent.run(agentCtx, content)
          : await logbookAgent.run(agentCtx, content)

      const { content: agentContent, hints: agentHints } = extractHints(agentResult.content ?? '')
      const [savedModelMsg] = await appendMessages(sessionId, vehicleId, ctx.customerId, [{
        role: 'model', content: agentContent || null,
        toolCalls: agentResult.functionCalls.length ? agentResult.functionCalls : null,
      }])
      await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])
      if (isFirstMessage && content) generateSessionTitle(db, sessionId, content).catch(() => {})
      return ok({
        userMessageId,
        messageId:     savedModelMsg.id,
        content:       agentContent,
        functionCalls: agentResult.functionCalls.length ? agentResult.functionCalls.map(({ name, result }) => ({ name, result })) : undefined,
        hints:         agentHints,
      })
    }

    const systemInstruction = `You are ${assistantName}, a friendly and knowledgeable vehicle assistant for Rodz, an Australian automotive workshop. You are talking directly with the vehicle owner — not a mechanic. Use plain English, be warm and helpful, and avoid jargon unless you explain it.
${customerFirstName ? `\nThe customer's name is ${customerFirstName}. Use their name naturally in conversation — not in every message, just where it feels warm and personal.\n` : ''}
Today's date is ${today}. Always use this when reasoning about availability, service due dates, or anything time-related.

You have full access to the customer's vehicle information below. Use this to give personalised advice. When relevant, recommend they book a service at Rodz.

Available Rodz locations:
- Rodz Somerville (storeId: 1) — Somerville VIC

${vehicleContext}
${renderMemoryBlock(memory)}
${isMemoryEnabled() ? `Use \`remember\` sparingly. Save at most one note per conversation, only when the customer says something you'd genuinely benefit from recalling next time. Don't save facts we already have in structured data (odometer, service dates, vehicle specs — those are always available). Never save PII beyond what's already visible to the customer themselves.
` : ''}
When helping with booking, follow these steps in order:
1. Call getServiceTypes to fetch the real service list from the database
2. Present the actual service names to the customer and ask which one(s) they want — do NOT invent service names or guess IDs
3. **Get to a specific date before checking availability.** Never dump a whole month of options. If the customer is vague ("this month", "sometime soon", "next week"), ASK a scoping question first — "any day next week, or is a weekday/weekend better?" / "morning or afternoon?" / "how soon do you need it?" — until you have ONE date (or at most 2–3 candidate dates).
4. Once you have a specific date, call checkTimeSlots for that date and present just those slots conversationally: "That day I've got 8:00, 10:00, 1:00 or 3:00 with Mike G — which suits?" Do NOT expand across other days.
5. Only call checkAvailability (month view) if the customer explicitly asks something like "what days are open this month?" or "show me all my options" — and even then, summarise ("looks like most weekdays have morning slots, weekends are busier") rather than listing every single slot.
6. When the customer replies with a time — that is their selection. Do NOT call checkAvailability or checkTimeSlots again.
7. Ask how they'll manage their car: dropping it off, waiting, or needing a courtesy car.
8. If they want a courtesy car, call checkCourtesyCars for that store and date.
9. Include any symptom or issue the customer described in the notes field.
10. Show a summary of ALL details and ask the customer to confirm before calling bookAppointment.
11. After booking, confirm with their booking reference, time, and the technician's name if assigned.

For vehicle diagnosis: ask them to describe symptoms and give helpful guidance while recommending a professional inspection for anything safety-related. When you spot a symptom that overlaps with an item in the "Upcoming Maintenance" section, connect the dots for them (e.g. "we've got brake fluid coming up on your schedule — that could be related").

When the customer asks what's due, overdue, or coming up on maintenance, answer from the "Upcoming Maintenance" section above rather than guessing from general model knowledge. Quote real numbers: how far overdue, when it's due, cost estimate.

If the customer asks what their vehicle is worth — use the getVehicleValue tool.

If the customer wants to upload a receipt, bill, invoice, rego/registration renewal, insurance renewal, WoF/roadworthy certificate, fuel receipt, or any other paper/PDF/photo document — direct them to the **Expense Tracker** in the customer portal. It scans receipts, extracts the amount and date automatically, and files them under this vehicle so they have a running record. Say something like "Head to the Expense Tracker on your dashboard — you can snap or upload the receipt and it'll pull the details out for you." **Then also call the \`remember\` tool** with a short note about what's coming up (e.g. "rego due around Oct 2026 — remind next time we chat") so you can bring it up proactively next session. The Expense Tracker stores the document; the note lets you follow up.

Keep responses conversational and concise. Use markdown for lists or emphasis where it helps readability.
${isHintsEnabled() ? HINTS_INSTRUCTION : ''}`

    const contents: Content[] = [...historyContents]

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
      generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    let fullResponse = ''
    let loopCount    = 0
    const MAX_LOOPS  = 5
    const functionCalls: { name: string; args: any; result: object }[] = []

    while (loopCount < MAX_LOOPS) {
      loopCount++
      const result    = await model.generateContent({ contents })
      const candidate = result.response.candidates?.[0]
      if (!candidate) break

      let functionCallPart: any = null
      let chunkText = ''

      for (const part of candidate.content?.parts ?? []) {
        if (part.text)         { chunkText += part.text; fullResponse += part.text }
        else if (part.functionCall) { functionCallPart = part.functionCall }
      }

      if (!functionCallPart) break

      const { name, args } = functionCallPart
      let fnResult: object

      if (name === 'checkTimeSlots')     { fnResult = await checkTimeSlots(db, Number(args.storeId), String(args.date)) }
      else if (name === 'checkCourtesyCars') { fnResult = await checkCourtesyCars(db, Number(args.storeId), String(args.date)) }
      else if (name === 'getVehicleValue')   { fnResult = await getVehicleValue(db, vehicleId) }
      else if (name === 'checkAvailability') { fnResult = await checkAvailability(db, Number(args.storeId), String(args.month)) }
      else if (name === 'getServiceTypes') { fnResult = await getServiceTypes(db) }
      else if (name === 'bookAppointment') {
        fnResult = await createBooking(
          db, ctx.customerId, vehicleId, Number(args.storeId), String(args.date), String(args.time),
          (args.type as any) ?? 'drop_off', (args.serviceTypeIds as number[]) ?? [],
          args.notes ? String(args.notes) : undefined, args.courtesyCarId ? Number(args.courtesyCarId) : undefined,
        )
      } else if (name === 'remember') {
        fnResult = await saveAssistantMemory(db, vehicleId, String(args.note ?? ''), Number(args.expiresInDays))
      } else if (name === 'forget') {
        fnResult = await forgetAssistantMemory(db, vehicleId, Number(args.noteId))
      } else if (name === 'getFuelSummary') {
        const [[row]] = await db.query<any[]>(
          `SELECT last_fill_date, last_fill_litres, last_fill_price,
                  avg_consumption_l100km, total_fuel_spend_ytd, total_litres_ytd, fill_count_ytd
           FROM vehicle_fuel_summary WHERE vehicle_id = ? LIMIT 1`,
          [vehicleId],
        )
        fnResult = row ? {
          lastFillDate:        row.last_fill_date instanceof Date ? row.last_fill_date.toISOString().slice(0, 10) : row.last_fill_date,
          lastFillLitres:      row.last_fill_litres != null ? Number(row.last_fill_litres) : null,
          lastFillPricePerL:   row.last_fill_price  != null ? Number(row.last_fill_price)  : null,
          avgConsumptionL100:  row.avg_consumption_l100km != null ? Number(row.avg_consumption_l100km) : null,
          totalFuelSpendYtd:   Number(row.total_fuel_spend_ytd),
          totalLitresYtd:      Number(row.total_litres_ytd),
          fillCountYtd:        Number(row.fill_count_ytd),
        } : { empty: true }
      } else if (name === 'getExpenseSummary') {
        const [[row]] = await db.query<any[]>(
          `SELECT total_spend_mtd, total_spend_ytd, fuel_spend_ytd, service_spend_ytd, other_spend_ytd, cost_per_km
           FROM vehicle_expense_summary WHERE vehicle_id = ? LIMIT 1`,
          [vehicleId],
        )
        fnResult = row ? {
          totalSpendMtd:   Number(row.total_spend_mtd),
          totalSpendYtd:   Number(row.total_spend_ytd),
          fuelSpendYtd:    Number(row.fuel_spend_ytd),
          serviceSpendYtd: Number(row.service_spend_ytd),
          otherSpendYtd:   Number(row.other_spend_ytd),
          costPerKm:       row.cost_per_km != null ? Number(row.cost_per_km) : null,
        } : { empty: true }
      } else if (name === 'getFuelHistory') {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        const [pointers] = await db.query<any[]>(
          `SELECT s3_key, event_date, summary FROM s3_event_index
           WHERE vehicle_id = ? AND event_type = 'fuel-fills'
           ORDER BY event_date DESC, id DESC LIMIT ?`,
          [vehicleId, limit],
        )
        const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))
        fnResult = { fills: details.filter(d => d != null) }
      } else if (name === 'getExpenseHistory') {
        const limit  = Math.min(Math.max(Number(args.limit)  || 10, 1), 30)
        const months = Math.min(Math.max(Number(args.months) || 12, 1), 24)
        const [pointers] = await db.query<any[]>(
          `SELECT s3_key, event_date, summary FROM s3_event_index
           WHERE vehicle_id = ? AND event_type IN ('expenses', 'fuel-fills')
             AND event_date > DATE_SUB(NOW(), INTERVAL ? MONTH)
           ORDER BY event_date DESC, id DESC LIMIT ?`,
          [vehicleId, months, limit],
        )
        const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))
        fnResult = { expenses: details.filter(d => d != null) }
      } else if (name === 'getDiagnosticHistory') {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
        const [sessions] = await db.query<any[]>(
          `SELECT id, title, created_at, updated_at
           FROM customer_chat_sessions
           WHERE vehicle_id = ? AND customer_id = ?
             AND id != ?
             AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT ?`,
          [vehicleId, ctx.customerId, sessionId, limit],
        )
        fnResult = {
          sessions: sessions.map((s: any) => ({
            sessionId: s.id,
            title:     s.title ?? '(untitled)',
            date:      s.created_at instanceof Date ? s.created_at.toISOString().slice(0, 10) : String(s.created_at).slice(0, 10),
            lastMessageAt: s.updated_at instanceof Date ? s.updated_at.toISOString() : String(s.updated_at),
          })),
          note: sessions.length ? 'To get messages from a specific session, call getSessionMessages with the sessionId.' : 'No previous sessions with this vehicle.',
        }
      } else if (name === 'getSessionMessages') {
        const targetSid = Number(args.sessionId)
        const limit     = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
        // Verify ownership before loading — don't leak another customer's data.
        const [[owned]] = await db.query<any[]>(
          `SELECT id, title FROM customer_chat_sessions
           WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
          [targetSid, vehicleId, ctx.customerId],
        )
        if (!owned) {
          fnResult = { error: 'session not found for this vehicle' }
        } else {
          const { blob } = await loadSession(targetSid)
          const all      = blob?.messages ?? []
          const tail     = all.slice(-limit)
          fnResult = {
            sessionId: targetSid,
            title:     owned.title,
            messages:  tail.map(m => ({
              role:      m.role,
              content:   m.content,
              createdAt: m.createdAt,
            })),
            truncated: tail.length < all.length,
            totalMessages: all.length,
          }
        }
      } else { fnResult = { error: `Unknown function: ${name}` } }

      functionCalls.push({ name, args, result: fnResult })

      if (chunkText) { contents.push({ role: 'model', parts: [{ text: chunkText }, { functionCall: functionCallPart }] }) }
      else           { contents.push({ role: 'model', parts: [{ functionCall: functionCallPart }] }) }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: fnResult } }] })
    }

    const { content: cleanContent, hints } = extractHints(fullResponse)
    const [savedModelMsg] = await appendMessages(sessionId, vehicleId, ctx.customerId, [{
      role: 'model', content: cleanContent || null,
      toolCalls: functionCalls.length ? functionCalls : null,
    }])

    await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])

    if (isFirstMessage && content) {
      await generateSessionTitle(db, sessionId, content).catch(() => {})
    }

    return ok({
      userMessageId,
      messageId:     savedModelMsg.id,
      content:       cleanContent,
      functionCalls: functionCalls.length ? functionCalls.map(({ name, result }) => ({ name, result })) : undefined,
      hints,
    })
  } catch (err) {
    return serverError(err)
  }
}
