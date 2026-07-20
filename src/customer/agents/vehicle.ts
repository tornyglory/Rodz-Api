import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import {
  assistantPersonaPreamble,
  ASSISTANT_VALUES,
  ASSISTANT_WORKSHOP_FRAMING,
  ASSISTANT_DIAGNOSIS_FLOW,
  ASSISTANT_SAFETY_RAILS,
  ASSISTANT_IDENTITY,
  ASSISTANT_SELLING_HINT,
  ASSISTANT_COVERAGE_GUIDANCE,
} from '../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../shared/prompts'

async function getVehicleValue(db: any, vehicleId: number): Promise<object> {
  const [[v]] = await db.query<any[]>(
    `SELECT make, model, year, series, fuel_type, transmission, body_type, colour,
            odometer_current, rego_state
     FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return { error: 'Vehicle not found' }

  const [[svcSummary]] = await db.query<any[]>(
    `SELECT COUNT(*) AS service_count, SUM(vsl.total) AS total_spend
     FROM vehicle_service_log vsl
     WHERE vsl.vehicle_rego = (SELECT rego FROM vehicles WHERE id = ? LIMIT 1)`,
    [vehicleId],
  )

  const odometerKm   = v.odometer_current ? Number(v.odometer_current) : null
  const serviceCount = svcSummary ? Number(svcSummary.service_count) : 0
  const totalSpend   = svcSummary?.total_spend ? Number(svcSummary.total_spend) : 0
  const age          = new Date().getFullYear() - Number(v.year)

  const prompt = `You are a vehicle valuation expert for the Australian used car market. Search for current listings of this exact vehicle on carsales.com.au, Autotrader Australia, and Gumtree Australia to find what comparable cars are actually selling for right now, then provide a market value estimate.

## Vehicle to value
${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}
Body: ${v.body_type ?? 'unknown'} | Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}
Colour: ${v.colour ?? 'not specified'} | Registered in: ${v.rego_state}
Age: ${age} years
Odometer: ${odometerKm ? `${odometerKm.toLocaleString()} km` : 'unknown'}

## Service Record
Rodz Smart Auto services on record: ${serviceCount}
Total spend at Rodz Smart Auto: $${totalSpend.toFixed(0)} AUD
${serviceCount > 0 ? 'This vehicle has a documented service history which adds value.' : 'No prior workshop service history on record.'}

Search for current Australian listings of this vehicle, then respond in this exact JSON format (no markdown, raw JSON only):
{
  "estimatedValueAud": { "low": <number>, "mid": <number>, "high": <number> },
  "comparableSales": [
    { "price": <number>, "odometer": <number or null>, "description": "<brief listing summary>" }
  ],
  "condition": "<excellent|good|fair|poor>",
  "conditionRationale": "<1 sentence>",
  "keyFactors": [
    { "factor": "<name>", "impact": "<positive|negative|neutral>", "detail": "<brief>" }
  ],
  "marketInsight": "<2-3 sentences on current Australian market for this vehicle>",
  "sellTips": ["<tip 1>", "<tip 2>", "<tip 3>"],
  "disclaimer": "This is an estimate based on current Australian listings. Actual sale price will vary based on vehicle condition, location, negotiation, and market timing."
}`

  const genAI      = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const valueModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // @ts-ignore
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  try {
    const result   = await valueModel.generateContent(prompt)
    const raw      = result.response.text().trim()
    const match    = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
    const jsonText = match ? match[1].trim() : raw.trim()
    const valuation = JSON.parse(jsonText)
    return { vehicle: { year: v.year, make: v.make, model: v.model, odometerKm, serviceCount }, valuation }
  } catch {
    return { error: 'Could not retrieve market value at this time.' }
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'getVehicleValue',
      description: 'Get a live market value estimate for this vehicle by searching current Australian car listings. Call this when the customer asks what their vehicle is worth, its resale value, or anything about market value.',
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string, imageBase64?: { data: string; mimeType: string }): Promise<AgentResult> {
  const active = await loadActivePrompt().catch(() => null)
  const guidance = active
    ? renderLearnedGuidance(active.learnedGuidance, { target: 'agent', agentName: 'vehicle' })
    : ''

  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}
${ASSISTANT_IDENTITY}
${ASSISTANT_VALUES}
${ASSISTANT_WORKSHOP_FRAMING}
${ASSISTANT_COVERAGE_GUIDANCE}
${ASSISTANT_DIAGNOSIS_FLOW}
${ASSISTANT_SAFETY_RAILS}

If the owner asks what the car is worth or what they could sell it for, use the getVehicleValue tool — it performs a live search of current Australian listings.

${ASSISTANT_SELLING_HINT}

Keep responses conversational and concise. Use markdown for lists or emphasis where it helps readability.
${guidance}`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const userParts: any[] = [{ text: message }]
  if (imageBase64) userParts.push({ inlineData: { mimeType: imageBase64.mimeType, data: imageBase64.data } })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: userParts }]

  return runAgentLoop(model, contents, async (name) => {
    if (name === 'getVehicleValue') return getVehicleValue(ctx.db, ctx.vehicleId)
    return { error: `Unknown tool: ${name}` }
  })
}
