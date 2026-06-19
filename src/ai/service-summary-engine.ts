import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

const ready = bootstrap()

export interface ServiceSummaryEvent {
  invoiceId: number
}

async function generateSummary(
  items: Array<{ description: string; type: string; qty: number }>,
  photoCount: number,
  vehicle: string,
  store: string,
  tech: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const itemLines = items
    .map(i => `- ${i.description}${i.qty > 1 ? ` x${i.qty}` : ''} (${i.type})`)
    .join('\n')

  const photoNote = photoCount > 0
    ? `\n${photoCount} photo${photoCount > 1 ? 's were' : ' was'} taken during this service.`
    : ''

  const prompt = `You are writing a service summary for a vehicle owner's digital service logbook.

Write 2–3 plain English sentences summarising the work listed below. Address the owner directly using "your vehicle" or "your". Be clear, warm, and informative. Do not mention prices or costs. Do not use bullet points. Write in continuous prose.${photoNote}

Vehicle: ${vehicle}
Workshop: ${store} · Technician: ${tech}

Work performed:
${itemLines}

Summary:`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

export const handler = async (event: ServiceSummaryEvent): Promise<void> => {
  await ready
  const db = getPool()

  const { invoiceId } = event
  if (!invoiceId) return

  try {
    // Fetch invoice + items + vehicle info
    const [[invoice]] = await db.query<any[]>(`
      SELECT
        i.id, i.vehicle_rego, i.odometer_in,
        CONCAT(ANY_VALUE(v.year), ' ', ANY_VALUE(v.make), ' ', ANY_VALUE(v.model)) AS vehicle_label,
        s.name AS store_name,
        CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech_name
      FROM invoices i
      JOIN stores   s  ON s.id  = i.store_id
      JOIN staff    st ON st.id = i.staff_id
      LEFT JOIN vehicles v ON v.rego = i.vehicle_rego AND v.is_active = 1
      WHERE i.id = ?
      GROUP BY i.id, s.name, st.first_name, st.last_name
      LIMIT 1
    `, [invoiceId])

    if (!invoice) return

    const [items] = await db.query<any[]>(
      `SELECT description, type, qty FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id`,
      [invoiceId],
    )

    if (!items.length) return

    const [[photoCount]] = await db.query<any[]>(
      `SELECT COUNT(*) AS cnt FROM photos WHERE invoice_id = ?`,
      [invoiceId],
    )

    const summary = await generateSummary(
      items,
      Number(photoCount?.cnt ?? 0),
      invoice.vehicle_label ?? invoice.vehicle_rego,
      invoice.store_name,
      invoice.tech_name,
    )

    await db.query(
      `UPDATE vehicle_service_log SET ai_summary = ?, updated_at = NOW() WHERE invoice_id = ?`,
      [summary, invoiceId],
    )
  } catch (err) {
    console.error('ServiceSummaryEngine error:', err)
  }
}
