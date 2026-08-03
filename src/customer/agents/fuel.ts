import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import { assistantPersonaPreamble } from '../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../shared/prompts'

const VALID_FUEL_TYPES = ['unleaded_91', 'unleaded_95', 'unleaded_98', 'diesel', 'lpg', 'e10', 'ev_kwh']

async function getNearbyFuelPrices(db: mysql.Pool, suburb: string, state: string | null, fuelType: string): Promise<object> {
  if (!VALID_FUEL_TYPES.includes(fuelType)) return { error: `Invalid fuel type. Must be one of: ${VALID_FUEL_TYPES.join(', ')}` }

  const whereClause = state
    ? '(LOWER(station_suburb) = LOWER(?) OR station_state = ?)'
    : 'LOWER(station_suburb) = LOWER(?)'
  const params = state ? [suburb, state, fuelType] : [suburb, fuelType]

  const [rows] = await db.query<any[]>(
    `SELECT station_name, station_suburb, station_state, price, price_unit, reported_at
     FROM (
       SELECT station_name, station_suburb, station_state, price, price_unit, reported_at,
         ROW_NUMBER() OVER (PARTITION BY station_name, station_suburb ORDER BY reported_at DESC) AS rn
       FROM fuel_station_prices
       WHERE ${whereClause} AND fuel_type = ?
     ) ranked
     WHERE rn = 1
     ORDER BY price ASC
     LIMIT 10`,
    params,
  )

  if (!rows.length) return { suburb, fuelType, stations: [], message: 'No price data yet for this area. Prices are crowd-sourced from customer receipts — check back as more customers contribute.' }

  const now = Date.now()
  return {
    suburb,
    fuelType,
    asOf: new Date().toISOString(),
    stations: rows.map((r: any) => {
      const reportedAt = r.reported_at instanceof Date ? r.reported_at : new Date(r.reported_at)
      const ageHours   = Math.round((now - reportedAt.getTime()) / 3_600_000)
      return {
        stationName: r.station_name,
        suburb:      r.station_suburb,
        state:       r.station_state ?? null,
        price:       Number(r.price),
        priceUnit:   r.price_unit,
        reportedAt:  reportedAt.toISOString(),
        ageHours,
        stale:       ageHours > 72,
      }
    }),
  }
}

async function getFuelTrends(db: mysql.Pool, stationName: string, suburb: string, fuelType: string, days: number): Promise<object> {
  if (!VALID_FUEL_TYPES.includes(fuelType)) return { error: `Invalid fuel type` }

  const [rows] = await db.query<any[]>(
    `SELECT DATE(reported_at) AS date, AVG(price) AS price
     FROM fuel_station_prices
     WHERE LOWER(station_name) = LOWER(?)
       AND LOWER(station_suburb) = LOWER(?)
       AND fuel_type = ?
       AND reported_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(reported_at)
     ORDER BY date ASC`,
    [stationName, suburb, fuelType, days],
  )

  if (!rows.length) return { stationName, suburb, fuelType, days, dataPoints: [], avgPrice: null, minPrice: null, maxPrice: null }

  const prices     = rows.map((r: any) => Number(r.price))
  const dataPoints = rows.map((r: any) => ({
    date:  r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    price: Math.round(Number(r.price) * 1000) / 1000,
  }))

  return {
    stationName, suburb, fuelType, days,
    dataPoints,
    avgPrice: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 1000) / 1000,
    minPrice: Math.round(Math.min(...prices) * 1000) / 1000,
    maxPrice: Math.round(Math.max(...prices) * 1000) / 1000,
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'getNearbyFuelPrices',
      description: 'Get the most recent fuel prices at stations in or near a suburb, sorted cheapest first.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          suburb:   { type: SchemaType.STRING, description: 'Suburb name to search' },
          state:    { type: SchemaType.STRING, description: 'State code (e.g. VIC, NSW) to expand the search — optional' },
          fuelType: { type: SchemaType.STRING, description: `Fuel type: ${VALID_FUEL_TYPES.join(' | ')}` },
        },
        required: ['suburb', 'fuelType'],
      },
    },
    {
      name: 'getFuelTrends',
      description: 'Get price history for a specific station and fuel type — useful for trend questions like "has BP been getting cheaper?"',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          stationName: { type: SchemaType.STRING, description: 'Exact station name from getNearbyFuelPrices result' },
          suburb:      { type: SchemaType.STRING, description: 'Station suburb' },
          fuelType:    { type: SchemaType.STRING, description: 'Fuel type' },
          days:        { type: SchemaType.NUMBER, description: 'How many days of history (default 90, max 365)' },
        },
        required: ['stationName', 'suburb', 'fuelType'],
      },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const homeSuburb = ctx.customerSuburb ?? 'your area'
  const homeState  = ctx.customerState ?? null

  const active = await loadActivePrompt().catch(() => null)
  const guidance = active
    ? renderLearnedGuidance(active.learnedGuidance, { target: 'agent', agentName: 'fuel' })
    : ''

  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}

Right now you're helping the owner find the cheapest place to fill up their car. The customer's home suburb is: ${homeSuburb}${homeState ? `, ${homeState}` : ''}.

Use getNearbyFuelPrices to find current prices. Default the suburb to their home suburb unless they specify somewhere else. Default fuel type to 'unleaded_95' unless they drive diesel or specify otherwise.

Prices are crowd-sourced from customer receipts — data may be sparse in some areas. Flag stale prices (ageHours > 72) as possibly outdated.

Be concise: list stations with price and age. Highlight the cheapest option clearly.
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
    if (name === 'getNearbyFuelPrices') {
      return getNearbyFuelPrices(ctx.db, String(args.suburb), args.state ? String(args.state) : homeState, String(args.fuelType ?? 'unleaded_95'))
    }
    if (name === 'getFuelTrends') {
      const days = Math.min(Math.max(Number(args.days ?? 90), 1), 365)
      return getFuelTrends(ctx.db, String(args.stationName), String(args.suburb), String(args.fuelType), days)
    }
    return { error: `Unknown tool: ${name}` }
  })
}
