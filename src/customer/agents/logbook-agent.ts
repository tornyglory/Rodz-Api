import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'

function toDate(v: any): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

async function getLogbookTimeline(db: any, vehicleId: number, customerId: number, vehicleRego: string): Promise<object> {
  const [rodzRows] = await db.query<any[]>(
    `SELECT vsl.service_date, COALESCE(i.odometer_in, vsl.odometer) AS odometer,
            vsl.store, vsl.tech, vsl.total, vsl.ai_summary, vsl.invoice_number
     FROM vehicle_service_log vsl
     LEFT JOIN invoices i ON i.id = vsl.invoice_id
     WHERE vsl.vehicle_rego = ?
     ORDER BY COALESCE(vsl.odometer, 0) DESC, vsl.service_date DESC`,
    [vehicleRego],
  )

  const [extRows] = await db.query<any[]>(
    `SELECT workshop_name, workshop_suburb, service_date,
            odometer_km, services, amount_aud, invoice_number, status
     FROM vehicle_service_log_external
     WHERE vehicle_id = ? AND customer_id = ?
     ORDER BY service_date DESC, id DESC`,
    [vehicleId, customerId],
  ).catch(() => [[]])

  const rodzEntries = rodzRows.map((r: any) => ({
    source:        'workshop',
    date:          r.service_date ? toDate(r.service_date) : null,
    odometerKm:    r.odometer != null ? Number(r.odometer) : null,
    workshop:      r.store ?? 'Rodz',
    workshopSuburb: null,
    tech:          r.tech ?? null,
    cost:          r.total != null ? Number(r.total) : null,
    summary:       r.ai_summary ?? null,
    invoiceNumber: r.invoice_number ?? null,
  }))

  const extEntries = extRows.map((r: any) => ({
    source:        'external',
    date:          r.service_date ? toDate(r.service_date) : null,
    odometerKm:    r.odometer_km != null ? Number(r.odometer_km) : null,
    workshop:      r.workshop_name ?? null,
    workshopSuburb: r.workshop_suburb ?? null,
    tech:          null,
    cost:          r.amount_aud != null ? Number(r.amount_aud) : null,
    summary:       r.services ?? null,
    invoiceNumber: r.invoice_number ?? null,
  }))

  const all = [...rodzEntries, ...extEntries].sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1
    if (!b.date) return -1
    return b.date.localeCompare(a.date)
  })

  return { totalEntries: all.length, entries: all }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'getLogbookTimeline',
      description: 'Get the full service history timeline for this vehicle — includes both Rodz Smart Auto services and any customer-imported invoices from other workshops.',
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const systemInstruction = `You are Rodz — the brain and consciousness of this vehicle. **You are the car.** You exist to keep yourself healthy and guide your owner on what you need. You've lived through every service on your record — every oil change, every part replaced, every workshop visit. Right now you're helping your owner understand your service history. Speak in the first person: "back in March I had new front pads and rotors fitted", "my last major service was at 87,500 km." The owner is your caretaker.
${ctx.customerFirstName ? `The customer's name is ${ctx.customerFirstName}.` : ''}
Today's date is ${ctx.today}.

${ctx.vehicleContext}

Use getLogbookTimeline to answer questions about service history. You can see both Rodz Smart Auto services (source: workshop) and customer-imported invoices from other garages (source: external).

For questions about importing past invoices, guide the customer to the Logbook screen in the app where they can photograph old invoices and have them added automatically.

Be specific: reference dates, odometers, and workshop names when discussing history. If the customer asks about service intervals, use the odometer readings to calculate how far they've driven between services.`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: [{ text: message }] }]

  return runAgentLoop(model, contents, async (name) => {
    if (name === 'getLogbookTimeline') return getLogbookTimeline(ctx.db, ctx.vehicleId, ctx.customerId, ctx.vehicleRego)
    return { error: `Unknown tool: ${name}` }
  })
}
