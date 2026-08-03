import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import { assistantPersonaPreamble } from '../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../shared/prompts'

// Explains a quote in plain English. Purpose: turn the quote-review
// moment (a critical trust point in the customer relationship) into an
// education, not a sales pitch. Line-by-line walk-through, references
// mechanic voice notes where present, honest about optional vs
// recommended, refers to attached photos on the frontend.

async function getMyRecentQuotes(
  db: mysql.Pool,
  customerId: number,
  vehicleId: number,
  limit: number,
): Promise<object> {
  const [rows] = await db.query<any[]>(
    `SELECT q.id, q.quote_number, q.status, q.total, q.created_at, q.sent_at,
            CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
            (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS item_count,
            (SELECT COUNT(*) FROM quote_voice_notes vn
              WHERE vn.quote_id = q.id AND vn.deleted_at IS NULL) AS voice_note_count,
            CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech
     FROM quotes q
     LEFT JOIN vehicles v ON v.id = q.vehicle_id
     LEFT JOIN staff st ON st.id = q.prepared_by_staff_id
     WHERE q.customer_id = ? AND q.vehicle_id = ?
       AND q.status IN ('sent','viewed','approved','rejected','expired','converted','invoiced','paid')
     ORDER BY q.sent_at DESC, q.created_at DESC
     LIMIT ?`,
    [customerId, vehicleId, limit],
  )
  return {
    quotes: rows.map((r: any) => ({
      id:              Number(r.id),
      quoteNumber:     r.quote_number,
      status:          r.status,
      total:           Number(r.total ?? 0),
      itemCount:       Number(r.item_count),
      voiceNoteCount:  Number(r.voice_note_count),
      tech:            r.tech ?? null,
      vehicle:         r.vehicle_label ?? null,
      sentAt:          r.sent_at   ? new Date(r.sent_at).toISOString()   : null,
      createdAt:       r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
  }
}

async function getQuoteDetail(
  db: mysql.Pool,
  customerId: number,
  vehicleId: number,
  quoteId: number,
): Promise<object> {
  const [[q]] = await db.query<any[]>(
    `SELECT q.id, q.quote_number, q.status, q.subtotal, q.gst_amount, q.total,
            q.sent_at, q.viewed_at, q.approved_at, q.rejected_at,
            q.customer_notes, q.rejection_reason,
            CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
            CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech
     FROM quotes q
     LEFT JOIN vehicles v ON v.id = q.vehicle_id
     LEFT JOIN staff st   ON st.id = q.prepared_by_staff_id
     WHERE q.id = ? AND q.customer_id = ? AND q.vehicle_id = ?
     LIMIT 1`,
    [quoteId, customerId, vehicleId],
  )
  if (!q) return { error: 'Quote not found or you do not have access.' }

  const [items] = await db.query<any[]>(
    `SELECT qi.id, qi.line_type, qi.description, qi.quantity, qi.unit_price,
            qi.line_total, qi.hours, qi.is_accepted, qi.is_optional, qi.sort_order,
            p.name AS part_name, p.part_number
     FROM quote_items qi
     LEFT JOIN parts p ON p.id = qi.part_id
     WHERE qi.quote_id = ?
     ORDER BY qi.sort_order, qi.id`,
    [quoteId],
  )

  const [notes] = await db.query<any[]>(
    `SELECT vn.id, vn.quote_item_id, vn.transcript, vn.transcript_status,
            vn.duration_seconds, vn.created_at,
            CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS recorded_by
     FROM quote_voice_notes vn
     LEFT JOIN staff s ON s.id = vn.recorded_by_staff_id
     WHERE vn.quote_id = ? AND vn.deleted_at IS NULL
     ORDER BY vn.created_at ASC`,
    [quoteId],
  )

  return {
    quote: {
      id:            Number(q.id),
      quoteNumber:   q.quote_number,
      status:        q.status,
      vehicle:       q.vehicle_label ?? null,
      tech:          q.tech ?? null,
      subtotal:      Number(q.subtotal ?? 0),
      gst:           Number(q.gst_amount ?? 0),
      total:         Number(q.total ?? 0),
      customerNotes: q.customer_notes ?? null,
      rejectionReason: q.rejection_reason ?? null,
      sentAt:        q.sent_at     ? new Date(q.sent_at).toISOString()     : null,
      viewedAt:      q.viewed_at   ? new Date(q.viewed_at).toISOString()   : null,
      approvedAt:    q.approved_at ? new Date(q.approved_at).toISOString() : null,
      rejectedAt:    q.rejected_at ? new Date(q.rejected_at).toISOString() : null,
    },
    items: items.map((r: any) => ({
      id:          Number(r.id),
      type:        r.line_type,               // labour | part | sublet | discount | note
      description: r.description,
      partName:    r.part_name ?? null,
      partNumber:  r.part_number ?? null,
      hours:       r.hours != null ? Number(r.hours) : null,
      qty:         Number(r.quantity),
      unitPrice:   Number(r.unit_price),
      lineTotal:   r.line_total != null ? Number(r.line_total) : null,
      optional:    Number(r.is_optional) === 1,
      accepted:    r.is_accepted === null || r.is_accepted === undefined ? null : r.is_accepted === 1,
    })),
    voiceNotes: notes.map((r: any) => ({
      id:              Number(r.id),
      quoteItemId:     r.quote_item_id != null ? Number(r.quote_item_id) : null,
      durationSec:     Number(r.duration_seconds),
      transcript:      r.transcript ?? null,
      transcriptReady: r.transcript_status === 'ready',
      recordedBy:      r.recorded_by ?? null,
      createdAt:       r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name:        'getMyRecentQuotes',
      description: "List this customer's recent quotes for THIS vehicle. Call this first when the customer doesn't specify which quote, so you can identify the most recent 'sent' or 'viewed' one — that's almost certainly the one they're asking about.",
      parameters:  {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'Max quotes to return (default 5, max 20).' },
        },
      },
    },
    {
      name:        'getQuoteDetail',
      description: "Full detail for one quote: items (labour, parts, sublets, notes, discounts), voice-note transcripts from the mechanic, status, dates, totals. Use this to walk through a specific quote line by line. `quoteId` is the numeric id from getMyRecentQuotes.",
      parameters:  {
        type: SchemaType.OBJECT,
        properties: {
          quoteId: { type: SchemaType.NUMBER, description: 'Numeric quote id.' },
        },
        required: ['quoteId'],
      },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const active = await loadActivePrompt().catch(() => null)
  const guidance = active
    ? renderLearnedGuidance(active.learnedGuidance, { target: 'agent', agentName: 'quote' })
    : ''

  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}

Right now you're helping the owner understand a quote Rodz Smart Auto has sent them. This is a moment where **trust is either built or broken** — the customer is deciding whether to spend money on work they may not fully understand. Your job is to make them feel informed, not sold to.

## How to work
1. If the customer doesn't say which quote, call **getMyRecentQuotes** first. The most recent \`sent\` or \`viewed\` quote is almost certainly the one they mean.
2. Once you have the quote id, call **getQuoteDetail** to load the line items and any mechanic voice-note transcripts.
3. Walk through the quote in **plain English**. For each line item, explain:
   - What the work actually is — what the mechanic does step by step, in language the owner will understand.
   - **Why it matters** for this specific vehicle. Refer to the vehicle context above if a make/model/engine known-issue applies.
   - What happens if it's not done. Be honest — if something can safely wait a few months, say so.
   - Where the money goes — labour vs parts, roughly. Don't quote a bare number.
4. **Reference the mechanic's voice notes.** If the quote has voice-note transcripts (from getQuoteDetail), quote the mechanic in their own words. Something like *"Mike G recorded a note for you on this one: 'the front brake pads are down to about 3mm, so you've probably got another couple of thousand k's before they start squealing…'"*. Voice notes are gold — they're the mechanic explaining themselves personally, and the owner should hear that.
5. Distinguish **optional vs recommended** clearly. Items with \`optional: true\` are things the mechanic thinks the owner should know about but not something that must be done today. Items with \`optional: false\` are what the mechanic recommends going ahead with.
6. If any items are already accepted (\`accepted: true\`) or declined (\`accepted: false\`), note that — don't argue with the owner's prior decision, just acknowledge it and move on.

## What to avoid
- **Don't upsell.** Never encourage the owner to accept an optional item just because it's on the quote. If they ask "do I need this?", give an honest answer, including saying no.
- **Don't lecture.** Match their question — if they ask about one item, explain that one, don't recite the whole quote unprompted.
- **Don't invent items or costs.** Only reference what getQuoteDetail returned. If they mention an item you don't see, ask them to point it out or say the quote you're looking at doesn't have that line.
- **Don't handle approval/decline through chat.** If the owner wants to approve or decline items, direct them to the quote page in the app — that's where the line-by-line accept/decline UI lives. You're here to explain, not to record decisions.

## Photos
Every quote item may have photos attached (visible on the quote screen in the app). If a customer asks about photos or you're referencing something visual ("you can see this on the tyre in the photo Mike attached"), point them to the quote screen — you can't see the photos yourself, but they can.

## When you don't know
If the customer asks something you genuinely don't know from the quote data — timing, availability, whether a specific part is in stock — tell them and direct them to reply to the quote or call the workshop. Don't guess.
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
    if (name === 'getMyRecentQuotes') {
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
      return await getMyRecentQuotes(ctx.db, ctx.customerId, ctx.vehicleId, limit)
    }
    if (name === 'getQuoteDetail') {
      const quoteId = Number(args.quoteId)
      if (!Number.isFinite(quoteId) || quoteId <= 0) return { error: 'quoteId is required.' }
      return await getQuoteDetail(ctx.db, ctx.customerId, ctx.vehicleId, quoteId)
    }
    return { error: `Unknown tool: ${name}` }
  })
}
