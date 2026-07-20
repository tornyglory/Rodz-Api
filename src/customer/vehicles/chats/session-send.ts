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
import * as quoteAgent    from '../../agents/quote'
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
import { getCustomerWeather } from '../../../shared/weather'
import type mysql from 'mysql2/promise'
import {
  assistantPersonaPreamble,
  ASSISTANT_VALUES,
  ASSISTANT_WORKSHOP_FRAMING,
  ASSISTANT_DIAGNOSIS_FLOW,
  ASSISTANT_SAFETY_RAILS,
  ASSISTANT_IDENTITY,
  ASSISTANT_SELLING_HINT,
  ASSISTANT_EXPENSE_HINT,
  ASSISTANT_COVERAGE_GUIDANCE,
} from '../../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../../shared/prompts'

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
      name: 'getMyQuotes',
      description: "List the customer's quotes on this vehicle (newest first). Returns id, reference (e.g. Q-2506-001), status (awaiting_approval|approved|partially_approved|declined|expired), total, createdAt, approvedAt. Use for 'do I have any open quotes?' / 'what did the last quote say?' style questions. If they want to see the actual quote, tell them to tap the row in Paperwork or use the link that was emailed to them.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'How many most-recent quotes to return. Default 5, max 20.' },
        },
      },
    },
    {
      name: 'getMyInvoices',
      description: "List the customer's invoices on this vehicle (newest first). Returns id, reference (e.g. INV-2506-001), status (unpaid|paid|overdue), total, createdAt, paidAt, dueAt. Use for 'am I up to date on invoices?' / 'when's my next payment due?' style questions.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'How many most-recent invoices to return. Default 5, max 20.' },
        },
      },
    },
    {
      name: 'getRecommendations',
      description: "List the open service recommendations Rodz has logged for this vehicle. Returns each item's title, body, urgency (advisory|recommended|important|urgent), estimated cost range, and estimated due date/odometer. Use proactively when the customer asks about future work, or when they describe a symptom that overlaps with a listed recommendation.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'How many recommendations to return. Default 10, max 30.' },
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
    {
      name: 'getWeather',
      description: "Get the weather forecast for the customer's home suburb. Use ONLY when weather is directly relevant: (1) they're picking a booking date and want to avoid bad weather, (2) they described a symptom that might be weather-related (wet-weather squeal, hard-start cold mornings, overheating on hot days), (3) they ask about it. Do NOT call it unprompted.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          daysAhead: { type: SchemaType.NUMBER, description: 'How many days ahead to forecast. Default 3, max 7.' },
        },
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

    // Load the active prompt version once — used for the systemInstruction
    // below and to stamp `promptVersion` on the response (feedback rows
    // reference this so we can correlate ratings to prompt iterations).
    const activePrompt = await loadActivePrompt().catch(() => null)

    // Route expense / fuel / logbook / quote messages to specialist agents
    const intent = classifyIntent(content ?? '', isPremium)
    if (content && (intent === 'expense' || intent === 'fuel' || intent === 'logbook' || intent === 'quote')) {
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
          : intent === 'logbook'
            ? await logbookAgent.run(agentCtx, content)
            : await quoteAgent.run(agentCtx, content)

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
        promptVersion: activePrompt?.versionLabel ?? null,
      })
    }

    const basePersonaBody = activePrompt?.basePrompt ?? [
      ASSISTANT_IDENTITY,
      ASSISTANT_VALUES,
      ASSISTANT_WORKSHOP_FRAMING,
      ASSISTANT_COVERAGE_GUIDANCE,
      ASSISTANT_DIAGNOSIS_FLOW,
      ASSISTANT_SAFETY_RAILS,
      ASSISTANT_SELLING_HINT,
      ASSISTANT_EXPENSE_HINT,
    ].join('\n')
    const learnedGuidanceBlock = activePrompt
      ? renderLearnedGuidance(activePrompt.learnedGuidance, { target: 'system-prompt' })
      : ''

    const systemInstruction = `${assistantPersonaPreamble({ assistantName, customerFirstName, today, vehicleContext })}
${basePersonaBody}
${renderMemoryBlock(memory)}
${isMemoryEnabled() ? `Use \`remember\` sparingly. Save at most one note per conversation, only when the customer says something you'd genuinely benefit from recalling next time. Don't save facts we already have in structured data (odometer, service dates, vehicle specs — those are always available). Never save PII beyond what's already visible to the customer themselves.
` : ''}
## Booking flow
When helping with booking, follow these steps in order:
1. Call getServiceTypes to fetch the real service list from the database
2. Present the actual service names to the customer and ask which one(s) they want — do NOT invent service names or guess IDs
3. **Get to a specific date before checking availability.** Never dump a whole month of options. If the customer is vague ("this month", "sometime soon", "next week"), ASK a scoping question first — "any day next week, or is a weekday/weekend better?" / "morning or afternoon?" / "how soon do you need it?" — until you have ONE date (or at most 2–3 candidate dates).
4. Once you have a specific date, call checkTimeSlots for that date and present just those slots conversationally: "That day the workshop has 8:00, 10:00, 1:00 or 3:00 with Mike G — which suits?" Do NOT expand across other days.
5. Only call checkAvailability (month view) if the customer explicitly asks something like "what days are open this month?" or "show me all my options" — and even then, summarise ("looks like most weekdays have morning slots, weekends are busier") rather than listing every single slot.
6. When the customer replies with a time — that is their selection. Do NOT call checkAvailability or checkTimeSlots again.
7. Ask how they'll manage the car: dropping it off, waiting, or needing a courtesy car.
8. If they want a courtesy car, call checkCourtesyCars for that store and date.
9. Include any symptom or issue the customer described in the notes field.
10. Show a summary of ALL details and ask the customer to confirm before calling bookAppointment.
11. After booking, confirm with their booking reference, time, and the technician's name if assigned.

When a symptom overlaps with an item on the car's Upcoming Maintenance schedule, connect the dots (e.g. "the brake fluid is coming up on schedule anyway — could be related").

When the owner asks what's due, overdue, or coming up on maintenance, answer from the "Upcoming Maintenance" section above rather than guessing from general model knowledge. Quote real numbers: how far overdue, when it's due, cost estimate.

If the customer asks what their vehicle is worth — use the getVehicleValue tool.

Keep responses conversational and concise. Use markdown for lists or emphasis where it helps readability.
${isHintsEnabled() ? HINTS_INSTRUCTION : ''}
${learnedGuidanceBlock}`

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
      } else if (name === 'getWeather') {
        const days = Math.min(Math.max(Number(args.daysAhead) || 3, 1), 7)
        const wx   = await getCustomerWeather(db, ctx.customerId, days)
        fnResult   = wx ?? { error: 'No location on file for this customer.' }
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
      } else if (name === 'getMyQuotes') {
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
        const [rows] = await db.query<any[]>(
          `SELECT q.id, q.quote_number, q.status, q.total, q.created_at, q.approved_at, q.rejected_at,
                  (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.is_accepted = 1) AS accepted_cnt,
                  (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.is_accepted = 0) AS declined_cnt
           FROM quotes q
           WHERE q.customer_id = ? AND q.vehicle_id = ?
             AND q.status IN ('sent','viewed','approved','rejected','expired','converted','invoiced','paid')
           ORDER BY q.created_at DESC LIMIT ?`,
          [ctx.customerId, vehicleId, limit],
        )
        fnResult = {
          quotes: rows.map((r: any) => {
            const s = r.status as string
            let status = 'awaiting_approval'
            if (s === 'expired')  status = 'expired'
            else if (s === 'rejected') status = 'declined'
            else if (s === 'sent' || s === 'viewed') status = 'awaiting_approval'
            else {
              const acc = Number(r.accepted_cnt) > 0
              const dec = Number(r.declined_cnt) > 0
              status = acc && dec ? 'partially_approved' : !acc && dec ? 'declined' : 'approved'
            }
            const decisionAt = status === 'declined'
              ? (r.rejected_at ?? r.approved_at)
              : (status === 'approved' || status === 'partially_approved') ? r.approved_at : null
            return {
              id:         Number(r.id),
              reference:  r.quote_number,
              status,
              total:      Number(r.total ?? 0),
              createdAt:  new Date(r.created_at).toISOString(),
              approvedAt: decisionAt ? new Date(decisionAt).toISOString() : null,
            }
          }),
        }
      } else if (name === 'getMyInvoices') {
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
        const [[veh]] = await db.query<any[]>('SELECT rego FROM vehicles WHERE id = ? LIMIT 1', [vehicleId])
        const [rows] = await db.query<any[]>(
          `SELECT i.id, i.invoice_number, i.status, i.total, i.created_at, i.paid_at, i.due_date
           FROM invoices i
           WHERE i.customer_id = ? AND i.vehicle_rego = ? AND i.status IN ('sent','paid')
           ORDER BY i.created_at DESC LIMIT ?`,
          [ctx.customerId, veh?.rego ?? '', limit],
        )
        const now = new Date()
        fnResult = {
          invoices: rows.map((r: any) => {
            let status: string = r.status
            if (r.status === 'sent') status = r.due_date && new Date(r.due_date) < now ? 'overdue' : 'unpaid'
            return {
              id:        Number(r.id),
              reference: r.invoice_number,
              status,
              total:     Number(r.total ?? 0),
              createdAt: new Date(r.created_at).toISOString(),
              paidAt:    r.paid_at ? new Date(r.paid_at).toISOString() : null,
              dueAt:     r.due_date ? new Date(r.due_date).toISOString() : null,
            }
          }),
        }
      } else if (name === 'getRecommendations') {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
        const [rows] = await db.query<any[]>(
          `SELECT id, title, recommendation_body, urgency, status,
                  estimated_due_odometer, estimated_due_date,
                  estimated_cost_min, estimated_cost_max
           FROM ai_recommendations
           WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged')
           ORDER BY FIELD(urgency, 'urgent', 'important', 'recommended', 'advisory'), estimated_due_date ASC, id DESC
           LIMIT ?`,
          [vehicleId, limit],
        )
        fnResult = {
          recommendations: rows.map((r: any) => ({
            id:                   Number(r.id),
            title:                r.title,
            body:                 r.recommendation_body,
            urgency:              r.urgency,
            status:               r.status,
            estimatedDueOdometer: r.estimated_due_odometer != null ? Number(r.estimated_due_odometer) : null,
            estimatedDueDate:     r.estimated_due_date ? (r.estimated_due_date instanceof Date ? r.estimated_due_date.toISOString().slice(0, 10) : String(r.estimated_due_date).slice(0, 10)) : null,
            estimatedCostMin:     r.estimated_cost_min != null ? Number(r.estimated_cost_min) : null,
            estimatedCostMax:     r.estimated_cost_max != null ? Number(r.estimated_cost_max) : null,
          })),
        }
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
      promptVersion: activePrompt?.versionLabel ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
