import type mysql from 'mysql2/promise'
import { searchItems, type EbaySearchItem } from '../shared/ebay'

// Booking-parts sourcing pipeline:
//
//   aggregateBookingParts(bookingId)
//     → shopping list [{ partNameId, partName, category, specHint, sourceServiceTypeId }]
//   sourceBookingParts(bookingId)
//     → runs aggregate + fires an eBay search per part in parallel +
//       persists a fresh part_sourcing_queries row + top-N
//       part_sourcing_offerings rows per part.
//
// Both are plain functions (not tied to HTTP or Lambda events) so
// they can be called from a POST handler, a booking-confirm hook,
// a scheduled Lambda, or a script. The HTTP layer stays thin.

export interface AggregatedPart {
  partNameId:          number
  partName:            string
  category:            string
  specHint:            string          // '' when no matching recommendation
  sourceServiceTypeId: number | null   // which service on this booking pulled the part in
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

// ─── Aggregate ─────────────────────────────────────────────────────────────

export async function aggregateBookingParts(
  db: mysql.Pool,
  bookingId: number,
): Promise<{ vehicleId: number; vehicleLabel: string; year: number; make: string; model: string; parts: AggregatedPart[] }> {
  const [[booking]] = await db.query<any[]>(
    `SELECT b.id, b.vehicle_id, v.year, v.make, v.model
     FROM bookings b
     JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.id = ? LIMIT 1`,
    [bookingId],
  )
  if (!booking) throw new Error(`Booking ${bookingId} not found`)

  const [svcRows] = await db.query<any[]>(
    'SELECT service_type_id FROM booking_services WHERE booking_id = ? ORDER BY sort_order',
    [bookingId],
  )
  const serviceTypeIds = svcRows.map(r => Number(r.service_type_id))
  if (serviceTypeIds.length === 0) {
    return {
      vehicleId: Number(booking.vehicle_id),
      vehicleLabel: `${booking.year} ${booking.make} ${booking.model}`,
      year: Number(booking.year), make: String(booking.make), model: String(booking.model),
      parts: [],
    }
  }

  // Every part in every step of every service on this booking
  const [partRows] = await db.query<any[]>(
    `SELECT DISTINCT s.service_type_id, p.part_name_id, pn.name, pn.category
     FROM service_type_step_parts p
     JOIN service_type_steps s ON s.id = p.step_id
     JOIN part_names pn        ON pn.id = p.part_name_id AND pn.is_active = 1
     WHERE s.service_type_id IN (${serviceTypeIds.map(() => '?').join(',')})`,
    serviceTypeIds,
  )

  // Merge duplicate parts across services (a filter service and an oil service
  // both include Engine Oil — dedupe to one shopping-list entry, keep the
  // service_type_id of the first occurrence for spec matching).
  const seen = new Set<number>()
  const list: AggregatedPart[] = []
  for (const r of partRows) {
    const id = Number(r.part_name_id)
    if (seen.has(id)) continue
    seen.add(id)
    list.push({
      partNameId:          id,
      partName:            String(r.name),
      category:            String(r.category ?? 'Other'),
      specHint:            '',   // filled in below
      sourceServiceTypeId: Number(r.service_type_id),
    })
  }

  // Vehicle-specific spec from the active recommendations. Same logic as
  // the job card endpoint — prefer a rec whose service_type_id matches
  // the step's service, fall back to any active rec that carries the
  // same part_name_id.
  if (list.length) {
    const [recRows] = await db.query<any[]>(
      `SELECT id, service_type_id, parts
       FROM ai_recommendations
       WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged') AND parts IS NOT NULL
       ORDER BY id DESC`,
      [booking.vehicle_id],
    )
    const specBySvcPart = new Map<string, string>()
    const specByPart    = new Map<number, string>()
    for (const rr of recRows) {
      let arr: any = rr.parts
      if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { continue } }
      if (!Array.isArray(arr)) continue
      for (const p of arr) {
        const pid  = Number(p?.id)
        const spec = typeof p?.spec === 'string' ? p.spec.trim() : ''
        if (!Number.isFinite(pid) || !spec) continue
        if (rr.service_type_id) {
          const k = `${Number(rr.service_type_id)}:${pid}`
          if (!specBySvcPart.has(k)) specBySvcPart.set(k, spec)
        }
        if (!specByPart.has(pid)) specByPart.set(pid, spec)
      }
    }
    for (const p of list) {
      const svcKey = p.sourceServiceTypeId != null ? `${p.sourceServiceTypeId}:${p.partNameId}` : null
      p.specHint = (svcKey && specBySvcPart.get(svcKey))
                || specByPart.get(p.partNameId)
                || ''
    }
  }

  return {
    vehicleId:    Number(booking.vehicle_id),
    vehicleLabel: `${booking.year} ${booking.make} ${booking.model}`,
    year:         Number(booking.year),
    make:         String(booking.make),
    model:        String(booking.model),
    parts:        list,
  }
}

// ─── Query composition ─────────────────────────────────────────────────────

// eBay search text — vehicle + part + spec. Kept under ~90 chars because
// eBay's own query parser drops meaning past that. The spec is the
// biggest lever: "5W-30 full synthetic ~4.2L" narrows sourcing far more
// than just "engine oil".
function composeQuery(part: AggregatedPart, year: number, make: string, model: string): string {
  const bits = [
    part.partName,
    part.specHint,
    String(year),
    make,
    model,
  ].map(s => s.trim()).filter(Boolean)
  return bits.join(' ').slice(0, 200)
}

// ─── Orchestrate ───────────────────────────────────────────────────────────

// Concurrency cap so we don't burst the eBay token bucket when a booking
// has many parts. 3 parallel × 4 marketplaces = 12 in-flight requests.
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
  const agg = await aggregateBookingParts(db, bookingId)

  const errors: SourcingResult['errors'] = []
  let queriesCreated = 0
  let offeringsCreated = 0

  // Wipe previous queries for this booking so the read endpoint always
  // shows the latest snapshot; historic offerings are safe to lose here
  // (staff sees the freshest prices, we don't need weeks-old snapshots).
  await db.query(
    'DELETE FROM part_sourcing_queries WHERE booking_id = ?',
    [bookingId],
  )

  await pool(agg.parts, 3, async (part) => {
    const query = composeQuery(part, agg.year, agg.make, agg.model)

    // Insert a pending row up-front so the read endpoint can show
    // "sourcing in progress" if we ever go async later.
    const [ins] = await db.query<any>(
      `INSERT INTO part_sourcing_queries
         (booking_id, vehicle_id, service_type_id, part_name_id, spec_hint,
          search_query, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [bookingId, agg.vehicleId, part.sourceServiceTypeId, part.partNameId, part.specHint || null, query],
    )
    const queryId = Number(ins.insertId)
    queriesCreated++

    let items: EbaySearchItem[] = []
    try {
      items = await searchItems({ query, limit: 5 })  // limit per marketplace; total = ~5×4 markets
    } catch (err: any) {
      errors.push({ partNameId: part.partNameId, message: err?.message ?? String(err) })
      await db.query(
        `UPDATE part_sourcing_queries
         SET status = 'failed', error = ?, completed_at = NOW()
         WHERE id = ?`,
        [String(err?.message ?? err).slice(0, 500), queryId],
      )
      return
    }

    const top = items.slice(0, TOP_OFFERINGS_PER_QUERY)
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
    vehicleId:    agg.vehicleId,
    vehicleLabel: agg.vehicleLabel,
    parts:        agg.parts.length,
    queriesCreated,
    offeringsCreated,
    errors,
  }
}
