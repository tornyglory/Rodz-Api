import type mysql from 'mysql2/promise'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { searchItems, type EbaySearchItem } from '../shared/ebay'

// Booking-parts sourcing pipeline:
//
//   deriveShoppingList(bookingId)
//     → LLM-derived shopping list from every work source on the booking
//       (booking_services + approved quote_items) enriched with vehicle-
//       specific specs and merged with existing recommendation specs.
//   sourceBookingParts(bookingId)
//     → runs derive + fires an eBay search per part in parallel +
//       persists a fresh part_sourcing_queries row + top-N
//       part_sourcing_offerings rows per part.
//
// Why LLM-driven: quote_items on real jobs are often free-text
// descriptions ("Brake Rotor Replace (per axle)") with no
// service_type_id link. And even catalogue-linked services need
// vehicle-specific specs (Brake Fluid → DOT 4 for THIS car, not just
// "brake fluid"). One LLM call unifies both problems.

export interface ShoppingListItem {
  partNameId:        number
  partName:          string
  category:          string
  specHint:          string          // vehicle-specific spec (LLM or rec derived)
  quantity:          string          // "4 pads" / "1L" / "each" — kept free-text for readability
  sourceDescription: string          // which service/quote item pulled this in
}

export interface SourcingResult {
  bookingId:      number
  vehicleId:      number
  vehicleLabel:   string
  parts:          number
  queriesCreated: number
  offeringsCreated: number
  errors:         Array<{ partNameId: number; message: string }>
}

const TOP_OFFERINGS_PER_QUERY = 10

// ─── Work-source gathering ─────────────────────────────────────────────────

interface WorkContext {
  bookingId:    number
  vehicleId:    number
  year:         number
  make:         string
  model:        string
  series:       string | null
  engineCode:   string | null
  engineSizeCc: number | null
  fuelType:     string | null
  transmission: string | null
  workDescriptions: string[]  // combined booking_services + quote_items
}

async function gatherWork(db: mysql.Pool, bookingId: number): Promise<WorkContext | null> {
  const [[b]] = await db.query<any[]>(
    `SELECT b.id, b.vehicle_id,
            v.year, v.make, v.model, v.series, v.engine_code, v.engine_size_cc,
            v.fuel_type, v.transmission
     FROM bookings b
     JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.id = ? LIMIT 1`,
    [bookingId],
  )
  if (!b) return null

  // Every work item on the booking, deduped by description text:
  //   * booking_services (via service_types.name)
  //   * quote_items on any approved/converted/invoiced/paid quote
  //   * service_job_items on the job (if any)
  const seen = new Set<string>()
  const workDescriptions: string[] = []
  const push = (s: string | null | undefined) => {
    if (!s) return
    const t = String(s).trim()
    if (!t) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    workDescriptions.push(t)
  }

  const [bsRows] = await db.query<any[]>(
    `SELECT st.name FROM booking_services bs JOIN service_types st ON st.id = bs.service_type_id
     WHERE bs.booking_id = ?`,
    [bookingId],
  )
  for (const r of bsRows) push(r.name)

  const [qiRows] = await db.query<any[]>(
    `SELECT qi.description, qi.quantity
     FROM quotes q
     JOIN quote_items qi ON qi.quote_id = q.id
     WHERE q.booking_id = ?
       AND q.status IN ('approved','converted','invoiced','paid')`,
    [bookingId],
  )
  for (const r of qiRows) {
    const qty = Number(r.quantity)
    push(qty && qty !== 1 ? `${r.description} × ${qty}` : r.description)
  }

  const [jiRows] = await db.query<any[]>(
    `SELECT ji.description
     FROM service_job_items ji
     JOIN service_jobs sj ON sj.id = ji.service_job_id
     WHERE sj.booking_id = ?`,
    [bookingId],
  )
  for (const r of jiRows) push(r.description)

  return {
    bookingId,
    vehicleId:    Number(b.vehicle_id),
    year:         Number(b.year),
    make:         String(b.make),
    model:        String(b.model),
    series:       b.series ?? null,
    engineCode:   b.engine_code ?? null,
    engineSizeCc: b.engine_size_cc != null ? Number(b.engine_size_cc) : null,
    fuelType:     b.fuel_type ?? null,
    transmission: b.transmission ?? null,
    workDescriptions,
  }
}

// ─── LLM-driven shopping list ──────────────────────────────────────────────

interface PartNameChoice { id: number; name: string; category: string }

async function loadPartNames(db: mysql.Pool): Promise<PartNameChoice[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, name, category FROM part_names WHERE is_active = 1 ORDER BY category, name`,
  )
  return rows.map(r => ({ id: Number(r.id), name: String(r.name), category: String(r.category ?? 'Other') }))
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return m ? m[1].trim() : text.trim()
}

export async function deriveShoppingList(
  db: mysql.Pool,
  bookingId: number,
): Promise<{ ctx: WorkContext | null; items: ShoppingListItem[] }> {
  const ctx = await gatherWork(db, bookingId)
  if (!ctx || ctx.workDescriptions.length === 0) return { ctx, items: [] }

  const partNames = await loadPartNames(db)
  const validPartIds = new Set(partNames.map(p => p.id))
  const partsByCat = new Map<string, PartNameChoice[]>()
  for (const p of partNames) {
    if (!partsByCat.has(p.category)) partsByCat.set(p.category, [])
    partsByCat.get(p.category)!.push(p)
  }
  const partsList = [...partsByCat.entries()]
    .map(([cat, arr]) => `[${cat}]\n${arr.map(p => `  ${p.id}: ${p.name}`).join('\n')}`)
    .join('\n\n')

  const vehicleLine = [
    `${ctx.year} ${ctx.make} ${ctx.model}`,
    ctx.series       ? ctx.series                   : null,
    ctx.engineCode   ? `engine ${ctx.engineCode}`   : null,
    ctx.engineSizeCc ? `${ctx.engineSizeCc}cc`      : null,
    ctx.fuelType,
    ctx.transmission,
  ].filter(Boolean).join(', ')

  // Merge existing rec-derived specs so we don't ask the LLM to
  // regenerate specs it already produced when the schedule was built.
  const [recRows] = await db.query<any[]>(
    `SELECT parts FROM ai_recommendations
     WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged') AND parts IS NOT NULL
     ORDER BY id DESC`,
    [ctx.vehicleId],
  )
  const specByPart = new Map<number, string>()
  for (const rr of recRows) {
    let arr: any = rr.parts
    if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { continue } }
    if (!Array.isArray(arr)) continue
    for (const p of arr) {
      const pid  = Number(p?.id)
      const spec = typeof p?.spec === 'string' ? p.spec.trim() : ''
      if (Number.isFinite(pid) && spec && !specByPart.has(pid)) specByPart.set(pid, spec)
    }
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are an Australian auto-parts specialist building a shopping list for a workshop job.

Vehicle: ${vehicleLine}

Work to be done on this vehicle (mix of booked services + quote items):
${ctx.workDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}

Break this work into a shopping list of the physical parts the workshop needs to order. Rules:

1. One row per DISTINCT part. If a job needs both front and rear brake pads, that's two rows (Front Brake Pad Set + Rear Brake Pad Set).
2. Pick the "partNameId" from the standardised catalogue below. NEVER invent ids — the id must appear in the catalogue.
3. "spec" is a vehicle-specific description (grade, viscosity, dimensions, OEM ref, quantity if relevant) — this feeds directly into an eBay search. Examples:
     "5W-30 semi-synthetic, ~4.4L"
     "OEM Toyota 04152-YZZA1 or equivalent"
     "DOT 4, ~1L for flush"
     "front pair, ~320mm ventilated"
     "iridium NGK ILKAR7B11 or equivalent, x4"
4. "quantity" is a plain-English quantity + unit ("×4", "1 set", "~1L", "each").
5. "sourceDescription" MUST match one of the work items above (verbatim) — traceability.
6. If the same part appears in multiple work items, list it ONCE with the strictest requirement + sourceDescription = the main one.
7. Include consumables the workshop will actually buy (fluids, filters, gaskets, pads, rotors, belts, plugs) — NOT tools, NOT labour.
8. If a work item is inspection-only ("Brake Inspection", "Battery Test"), it may have zero parts — that's fine, skip it.
9. If a work item has no bookable service equivalent but you can still identify the parts, still include them.

STANDARDISED PART CATALOGUE (grouped by category):
${partsList}

Return a JSON array only, no markdown fences. Schema:
[
  {
    "partNameId":        362,
    "spec":              "front axle, ~320mm ventilated, ~2 units",
    "quantity":          "×2",
    "sourceDescription": "Brake Rotor Replace (per axle)"
  }
]

If there are genuinely no parts to source (all inspection-only), return an empty array [].`

  const result = await model.generateContent(prompt)
  const text   = result.response.text()
  let parsed: any
  try { parsed = JSON.parse(stripFences(text)) } catch (err) {
    console.error('[sourcing] shopping-list JSON parse failed:', (err as any)?.message)
    return { ctx, items: [] }
  }
  if (!Array.isArray(parsed)) return { ctx, items: [] }

  const nameById = new Map(partNames.map(p => [p.id, p]))
  const items: ShoppingListItem[] = []
  const seenPartIds = new Set<number>()
  for (const raw of parsed) {
    const id = Number(raw?.partNameId)
    if (!Number.isFinite(id) || !validPartIds.has(id) || seenPartIds.has(id)) continue
    seenPartIds.add(id)
    const p = nameById.get(id)!
    let spec = typeof raw?.spec === 'string' ? raw.spec.trim().slice(0, 200) : ''
    // Prefer an existing rec-generated spec if the LLM's is empty.
    if (!spec) spec = specByPart.get(id) ?? ''
    items.push({
      partNameId:        id,
      partName:          p.name,
      category:          p.category,
      specHint:          spec,
      quantity:          typeof raw?.quantity          === 'string' ? raw.quantity.trim().slice(0, 40)          : '',
      sourceDescription: typeof raw?.sourceDescription === 'string' ? raw.sourceDescription.trim().slice(0, 200) : '',
    })
  }
  return { ctx, items }
}

// ─── Query composition ─────────────────────────────────────────────────────

function composeQuery(item: ShoppingListItem, ctx: WorkContext): string {
  const bits = [
    item.partName,
    item.specHint,
    String(ctx.year),
    ctx.make,
    ctx.model,
  ].map(s => s.trim()).filter(Boolean)
  return bits.join(' ').slice(0, 200)
}

// ─── Orchestrate ───────────────────────────────────────────────────────────

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export async function sourceBookingParts(
  db: mysql.Pool,
  bookingId: number,
): Promise<SourcingResult> {
  const { ctx, items } = await deriveShoppingList(db, bookingId)
  if (!ctx) throw new Error(`Booking ${bookingId} not found`)

  const errors: SourcingResult['errors'] = []
  let queriesCreated = 0
  let offeringsCreated = 0

  await db.query(
    'DELETE FROM part_sourcing_queries WHERE booking_id = ?',
    [bookingId],
  )

  const vehicleLabel = `${ctx.year} ${ctx.make} ${ctx.model}`

  await pool(items, 3, async (item) => {
    const query = composeQuery(item, ctx)

    // Store the shopping-list metadata on the query so the read
    // endpoint can surface { sourceDescription, quantity } to the UI.
    // Reuse the existing spec_hint column for the LLM-derived spec.
    const [ins] = await db.query<any>(
      `INSERT INTO part_sourcing_queries
         (booking_id, vehicle_id, service_type_id, part_name_id, spec_hint,
          search_query, status)
       VALUES (?, ?, NULL, ?, ?, ?, 'pending')`,
      [bookingId, ctx.vehicleId, item.partNameId, item.specHint || null, query],
    )
    const queryId = Number(ins.insertId)
    queriesCreated++

    let searchResults: EbaySearchItem[] = []
    try {
      searchResults = await searchItems({ query, limit: 5 })
    } catch (err: any) {
      errors.push({ partNameId: item.partNameId, message: err?.message ?? String(err) })
      await db.query(
        `UPDATE part_sourcing_queries
         SET status = 'failed', error = ?, completed_at = NOW()
         WHERE id = ?`,
        [String(err?.message ?? err).slice(0, 500), queryId],
      )
      return
    }

    const top = searchResults.slice(0, TOP_OFFERINGS_PER_QUERY)
    const cheapest = top[0]?.totalAud ?? null
    const fastest  = top
      .map(i => i.deliveryMaxDays)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)[0] ?? null

    for (const it of top) {
      await db.query(
        `INSERT INTO part_sourcing_offerings
           (query_id, supplier, marketplace, external_id, title,
            price_native, currency, shipping_native, fx_rate,
            price_aud, shipping_aud, total_aud,
            delivery_min_days, delivery_max_days,
            item_condition, seller_name, seller_feedback_pct,
            product_url, image_url, location)
         VALUES (?, 'ebay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          queryId, it.marketplace, it.itemId, it.title.slice(0, 500),
          it.price, it.currency, it.shipping, it.fxRate,
          it.priceAud, it.shippingAud, it.totalAud,
          it.deliveryMinDays, it.deliveryMaxDays,
          it.condition, it.seller.name, it.seller.feedbackPct,
          it.itemWebUrl.slice(0, 800), it.imageUrl?.slice(0, 800) ?? null, it.location,
        ],
      )
      offeringsCreated++
    }

    await db.query(
      `UPDATE part_sourcing_queries
       SET status = 'completed', results_count = ?, cheapest_total_aud = ?, fastest_days_max = ?, completed_at = NOW()
       WHERE id = ?`,
      [top.length, cheapest, fastest, queryId],
    )
  })

  return {
    bookingId,
    vehicleId:    ctx.vehicleId,
    vehicleLabel,
    parts:        items.length,
    queriesCreated,
    offeringsCreated,
    errors,
  }
}
