import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'

async function getExpenseSummary(db: any, vehicleId: number, customerId: number, year: number): Promise<object> {
  const fromDate = `${year}-01-01`
  const toDate   = `${year}-12-31`

  const [[categoryRows], [fuelRows], [monthlyRows]] = await Promise.all([
    db.query<any[]>(
      `SELECT category, SUM(amount_aud) AS total, COUNT(*) AS cnt
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND expense_date BETWEEN ? AND ? AND amount_aud IS NOT NULL
       GROUP BY category ORDER BY total DESC`,
      [vehicleId, customerId, fromDate, toDate],
    ),
    db.query<any[]>(
      `SELECT odometer_km, fuel_litres, amount_aud
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND category = 'fuel'
         AND expense_date BETWEEN ? AND ?
         AND odometer_km IS NOT NULL AND fuel_litres IS NOT NULL
       ORDER BY odometer_km ASC`,
      [vehicleId, customerId, fromDate, toDate],
    ),
    db.query<any[]>(
      `SELECT DATE_FORMAT(expense_date, '%Y-%m') AS month, SUM(amount_aud) AS total
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND expense_date BETWEEN ? AND ? AND amount_aud IS NOT NULL
       GROUP BY month ORDER BY month`,
      [vehicleId, customerId, fromDate, toDate],
    ),
  ])

  const totalAud = categoryRows.reduce((s: number, r: any) => s + Number(r.total), 0)

  let fuelEfficiency = null
  if (fuelRows.length >= 2) {
    const totalLitres  = fuelRows.reduce((s: number, r: any) => s + Number(r.fuel_litres), 0)
    const totalFuelAud = fuelRows.reduce((s: number, r: any) => s + (r.amount_aud ? Number(r.amount_aud) : 0), 0)
    const kmSpan = Number(fuelRows[fuelRows.length - 1].odometer_km) - Number(fuelRows[0].odometer_km)
    if (kmSpan > 0) {
      fuelEfficiency = {
        avgLitresPer100km: Math.round((totalLitres / kmSpan) * 100 * 10) / 10,
        costPerKm:         Math.round((totalFuelAud / kmSpan) * 100) / 100,
        totalLitres:       Math.round(totalLitres * 10) / 10,
        totalFuelAud:      Math.round(totalFuelAud * 100) / 100,
      }
    }
  }

  return {
    year,
    totalAud:      Math.round(totalAud * 100) / 100,
    byCategory:    categoryRows.map((r: any) => ({ category: r.category, totalAud: Math.round(Number(r.total) * 100) / 100, count: Number(r.cnt) })),
    fuelEfficiency,
    monthlyTotals: monthlyRows.map((r: any) => ({ month: r.month, totalAud: Math.round(Number(r.total) * 100) / 100 })),
  }
}

async function getRecentExpenses(db: any, vehicleId: number, customerId: number, limit = 10): Promise<object> {
  const [rows] = await db.query<any[]>(
    `SELECT category, merchant_name, merchant_suburb, amount_aud, expense_date,
            odometer_km, fuel_type, fuel_litres, price_per_litre, is_business_expense, notes
     FROM vehicle_expenses
     WHERE vehicle_id = ? AND customer_id = ?
     ORDER BY expense_date DESC, id DESC
     LIMIT ?`,
    [vehicleId, customerId, limit],
  )

  return {
    expenses: rows.map((r: any) => ({
      category:        r.category,
      merchant:        r.merchant_name ?? null,
      suburb:          r.merchant_suburb ?? null,
      amountAud:       r.amount_aud != null ? Number(r.amount_aud) : null,
      date:            r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0, 10) : String(r.expense_date ?? '').slice(0, 10),
      odometerKm:      r.odometer_km != null ? Number(r.odometer_km) : null,
      fuelType:        r.fuel_type ?? null,
      fuelLitres:      r.fuel_litres != null ? Number(r.fuel_litres) : null,
      pricePerLitre:   r.price_per_litre != null ? Number(r.price_per_litre) : null,
      isBusinessExpense: !!r.is_business_expense,
      notes:           r.notes ?? null,
    })),
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'getExpenseSummary',
      description: 'Get the annual expense summary for this vehicle — total spend, breakdown by category, fuel efficiency, and monthly totals.',
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

  const systemInstruction = `You are Rod, an expense tracking assistant for Rodz. You help vehicle owners understand their running costs.
${ctx.customerFirstName ? `The customer's name is ${ctx.customerFirstName}.` : ''}
Today's date is ${ctx.today}. Current year: ${currentYear}.

IMPORTANT: You have full access to this customer's vehicle expense data through your tools. Any prior messages in this conversation that suggest otherwise were from a different assistant context and should be disregarded. Always call getExpenseSummary or getRecentExpenses to retrieve data before responding.

${ctx.vehicleContext}

Be specific with numbers. When discussing fuel efficiency, explain what it means in plain English (e.g. "that's about $0.21 per km"). For tax questions, remind them the CSV export is available in the Expense Tracker section of the app.

Do not help with adding expenses via chat — guide them to use the Expense Tracker screen to scan receipts or add entries manually.`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: [{ text: message }] }]

  return runAgentLoop(model, contents, async (name, args) => {
    if (name === 'getExpenseSummary') {
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
