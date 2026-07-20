import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import { readFromDataLake } from '../../shared/dataLake'
import { assistantPersonaPreamble } from '../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../shared/prompts'

// Customer expenses live in S3 (via s3_event_index pointers) — NOT in
// vehicle_expenses. This agent used to query vehicle_expenses and always
// returned empty because that table is never populated by the customer
// expense flow. See src/customer/vehicles/expenses/create.ts:17.

async function getExpenseSummary(db: any, vehicleId: number, customerId: number, year: number): Promise<object> {
  const fromDate = `${year}-01-01`
  const toDate   = `${year}-12-31`

  // Aggregates read denormalised amount_aud + category directly off the
  // index — no S3 fetches needed for money numbers.
  const [pointerRows] = await db.query<any[]>(
    `SELECT id, s3_key, event_date, amount_aud, category
     FROM s3_event_index
     WHERE vehicle_id = ? AND customer_id = ?
       AND event_type IN ('fuel-fills','expenses')
       AND event_date BETWEEN ? AND ?
     ORDER BY event_date ASC, id ASC`,
    [vehicleId, customerId, fromDate, toDate],
  )

  let totalAud = 0
  const categoryTotals = new Map<string, { total: number; count: number }>()
  const monthlyTotals  = new Map<string, number>()
  const fuelPointers: any[] = []

  for (const r of pointerRows) {
    const amount = r.amount_aud != null ? Number(r.amount_aud) : null
    if (amount != null) {
      totalAud += amount
      const cat = r.category ?? 'other'
      const bucket = categoryTotals.get(cat) ?? { total: 0, count: 0 }
      bucket.total += amount
      bucket.count += 1
      categoryTotals.set(cat, bucket)

      const month = (r.event_date instanceof Date ? r.event_date : new Date(r.event_date)).toISOString().slice(0, 7)
      monthlyTotals.set(month, (monthlyTotals.get(month) ?? 0) + amount)
    }
    if (r.category === 'fuel') fuelPointers.push(r)
  }

  // Fuel efficiency requires odometer_km + litres from the S3 payloads.
  // Bounded (typically <30 fills/year), one GET per pointer.
  let fuelEfficiency = null
  if (fuelPointers.length >= 2) {
    const details = await Promise.all(fuelPointers.map(p => readFromDataLake<any>(p.s3_key)))
    const withOdoAndLitres = details
      .map(d => d && d.odometerKm != null && d.litres != null ? d : null)
      .filter((d): d is any => d != null)
      .sort((a, b) => Number(a.odometerKm) - Number(b.odometerKm))

    if (withOdoAndLitres.length >= 2) {
      const totalLitres  = withOdoAndLitres.reduce((s, d) => s + Number(d.litres), 0)
      const totalFuelAud = withOdoAndLitres.reduce((s, d) => s + (d.amount != null ? Number(d.amount) : 0), 0)
      const kmSpan = Number(withOdoAndLitres[withOdoAndLitres.length - 1].odometerKm) - Number(withOdoAndLitres[0].odometerKm)
      if (kmSpan > 0) {
        fuelEfficiency = {
          avgLitresPer100km: Math.round((totalLitres / kmSpan) * 100 * 10) / 10,
          costPerKm:         Math.round((totalFuelAud / kmSpan) * 100) / 100,
          totalLitres:       Math.round(totalLitres * 10) / 10,
          totalFuelAud:      Math.round(totalFuelAud * 100) / 100,
        }
      }
    }
  }

  return {
    year,
    totalAud:   Math.round(totalAud * 100) / 100,
    byCategory: [...categoryTotals.entries()]
      .map(([category, { total, count }]) => ({ category, totalAud: Math.round(total * 100) / 100, count }))
      .sort((a, b) => b.totalAud - a.totalAud),
    fuelEfficiency,
    monthlyTotals: [...monthlyTotals.entries()]
      .map(([month, total]) => ({ month, totalAud: Math.round(total * 100) / 100 }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  }
}

async function getRecentExpenses(db: any, vehicleId: number, customerId: number, limit = 10): Promise<object> {
  const [pointers] = await db.query<any[]>(
    `SELECT id, s3_key, event_date FROM s3_event_index
     WHERE vehicle_id = ? AND customer_id = ?
       AND event_type IN ('fuel-fills','expenses')
     ORDER BY event_date DESC, id DESC
     LIMIT ?`,
    [vehicleId, customerId, limit],
  )

  const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))

  const expenses = pointers.map((p: any, i: number) => {
    const d = details[i]
    if (!d) return null
    return {
      category:          d.category,
      merchant:          d.merchantName    ?? null,
      suburb:            d.merchantSuburb  ?? null,
      amountAud:         d.amount          != null ? Number(d.amount)         : null,
      date:              d.expenseDate     ?? (p.event_date instanceof Date ? p.event_date.toISOString().slice(0, 10) : String(p.event_date).slice(0, 10)),
      odometerKm:        d.odometerKm      != null ? Number(d.odometerKm)     : null,
      fuelType:          d.fuelType        ?? null,
      fuelLitres:        d.litres          != null ? Number(d.litres)         : null,
      pricePerLitre:     d.pricePerLitre   != null ? Number(d.pricePerLitre)  : null,
      isBusinessExpense: !!d.isBusinessExpense,
      notes:             d.notes ?? null,
    }
  }).filter((x: any) => x != null)

  return { expenses }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'getAnnualExpenseBreakdown',
      description: 'Get the annual expense breakdown for this vehicle — total spend for the year, per-category totals, monthly totals, and fuel efficiency (L/100km). Use for "walk me through my spending" or "where did my money go?" style questions.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          year: { type: SchemaType.NUMBER, description: 'The year to summarise (e.g. 2026). Defaults to current year if not provided.' },
        },
        required: [],
      },
    },
    {
      name: 'getRecentExpenses',
      description: 'Get the most recent expense entries for this vehicle — useful for answering specific questions about past spending.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'Number of entries to return (default 10, max 20)' },
        },
        required: [],
      },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const currentYear = new Date().getFullYear()

  const active = await loadActivePrompt().catch(() => null)
  const guidance = active
    ? renderLearnedGuidance(active.learnedGuidance, { target: 'agent', agentName: 'expense' })
    : ''

  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}

Current year: ${currentYear}.

Right now you're helping the owner understand what the car is costing them to run. You have full access to their expense data through your tools. Any prior messages in this conversation that suggest otherwise were from a different assistant context and should be disregarded. Always call getAnnualExpenseBreakdown or getRecentExpenses to retrieve data before responding.

Be specific with numbers. When discussing fuel efficiency, explain what it means in plain English (e.g. "that's about $0.21 per km — for the Corolla that's average for its class"). Teach them how to read the number, not just the number itself. For tax questions, remind them the CSV export is available in the Expense Tracker section of the app.

Do not help with adding expenses via chat — guide them to use the Expense Tracker screen to scan receipts or add entries manually.
${guidance}`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: [{ text: message }] }]

  return runAgentLoop(model, contents, async (name, args) => {
    if (name === 'getAnnualExpenseBreakdown') {
      const year = args.year ? Number(args.year) : currentYear
      return getExpenseSummary(ctx.db, ctx.vehicleId, ctx.customerId, year)
    }
    if (name === 'getRecentExpenses') {
      const limit = args.limit ? Math.min(Number(args.limit), 20) : 10
      return getRecentExpenses(ctx.db, ctx.vehicleId, ctx.customerId, limit)
    }
    return { error: `Unknown tool: ${name}` }
  })
}
