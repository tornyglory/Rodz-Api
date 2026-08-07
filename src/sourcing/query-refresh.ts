import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { searchItems } from '../shared/ebay'

// POST /parts-sourcing-queries/{queryId}/refresh
// Body: { query?, marketplaces?, minAud?, maxAud?, limit? }  — all optional
//
// Re-runs ONE row's search. Useful when the LLM's default query didn't
// return great hits and the workshop wants to tweak it — broaden the
// terms, focus on one marketplace, cap the price range, etc.
//
// Semantics:
//   * `query` overrides the stored search_query for THIS run (and gets
//     persisted so subsequent booking-level refreshes remember it)
//   * `marketplaces` scopes to the given markets (default = env)
//   * `minAud` / `maxAud` filter delivered-to-AU total
//   * `limit` is per-marketplace (default 10)
//
// Offerings for this query are wiped and replaced — mirrors the
// booking-level refresh behaviour.

const ready = bootstrap()
const TOP_OFFERINGS_PER_QUERY = 20

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const queryId = Number(event.pathParameters?.queryId)

  if (!Number.isFinite(queryId) || queryId <= 0) return notFound('Query')

  try {
    const [[q]] = await db.query<any[]>(
      `SELECT q.id, q.booking_id, q.vehicle_id, q.part_name_id, q.spec_hint, q.search_query,
              b.store_id, pn.name AS part_name
       FROM part_sourcing_queries q
       LEFT JOIN bookings   b  ON b.id  = q.booking_id
       LEFT JOIN part_names pn ON pn.id = q.part_name_id
       WHERE q.id = ? LIMIT 1`,
      [queryId],
    )
    if (!q) return notFound('Query')
    if (b_check(ctx, q.store_id)) return notFound('Query')  // 404, not 403 — don't leak

    const body: any = event.body ? JSON.parse(event.body) : {}
    const newQuery    = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 300) : null
    const marketsRaw  = body.marketplaces
    const marketplaces = Array.isArray(marketsRaw) && marketsRaw.length
      ? marketsRaw.map(String).map(s => s.trim()).filter(Boolean)
      : undefined
    const limit  = body.limit  ? Math.max(1, Math.min(50, Number(body.limit))) : 10
    const minAud = body.minAud != null ? Number(body.minAud) : undefined
    const maxAud = body.maxAud != null ? Number(body.maxAud) : undefined

    const finalQuery = newQuery ?? String(q.search_query)

    // Mark pending, wipe old offerings, run search, insert new, update stats
    await db.query(
      `UPDATE part_sourcing_queries
       SET status = 'pending', search_query = ?, error = NULL, results_count = 0,
           cheapest_total_aud = NULL, fastest_days_max = NULL, completed_at = NULL,
           queried_at = NOW()
       WHERE id = ?`,
      [finalQuery, queryId],
    )
    await db.query('DELETE FROM part_sourcing_offerings WHERE query_id = ?', [queryId])

    let items
    try {
      items = await searchItems({
        query:    finalQuery,
        limit,
        marketplaces,
        minPrice: minAud,
        maxPrice: maxAud,
      })
    } catch (err: any) {
      await db.query(
        `UPDATE part_sourcing_queries
         SET status = 'failed', error = ?, completed_at = NOW()
         WHERE id = ?`,
        [String(err?.message ?? err).slice(0, 500), queryId],
      )
      return ok({ refreshed: false, error: String(err?.message ?? err), queryId })
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
    }

    await db.query(
      `UPDATE part_sourcing_queries
       SET status = 'completed', results_count = ?, cheapest_total_aud = ?,
           fastest_days_max = ?, completed_at = NOW()
       WHERE id = ?`,
      [top.length, cheapest, fastest, queryId],
    )

    // Fresh view of just this query row + its new offerings
    const [[freshQ]] = await db.query<any[]>(
      `SELECT q.*, pn.name AS part_name, pn.category AS part_category
       FROM part_sourcing_queries q
       JOIN part_names pn ON pn.id = q.part_name_id
       WHERE q.id = ?`,
      [queryId],
    )
    const [offRows] = await db.query<any[]>(
      `SELECT * FROM part_sourcing_offerings WHERE query_id = ? ORDER BY total_aud ASC`,
      [queryId],
    )

    return ok({
      refreshed: true,
      query: {
        id:                Number(freshQ.id),
        partNameId:        Number(freshQ.part_name_id),
        partName:          String(freshQ.part_name),
        category:          String(freshQ.part_category ?? 'Other'),
        specHint:          freshQ.spec_hint ?? '',
        searchQuery:       String(freshQ.search_query),
        status:            String(freshQ.status),
        resultsCount:      Number(freshQ.results_count),
        cheapestTotalAud:  freshQ.cheapest_total_aud != null ? Number(freshQ.cheapest_total_aud) : null,
        fastestDaysMax:    freshQ.fastest_days_max != null ? Number(freshQ.fastest_days_max) : null,
        queriedAt:         freshQ.queried_at ? new Date(freshQ.queried_at).toISOString() : null,
        completedAt:       freshQ.completed_at ? new Date(freshQ.completed_at).toISOString() : null,
        offerings:         offRows.map(r => ({
          id:                Number(r.id),
          supplier:          String(r.supplier),
          marketplace:       r.marketplace ?? null,
          externalId:        r.external_id ?? null,
          title:             String(r.title),
          priceNative:       Number(r.price_native),
          currency:          String(r.currency),
          shippingNative:    r.shipping_native != null ? Number(r.shipping_native) : null,
          fxRate:            Number(r.fx_rate),
          priceAud:          Number(r.price_aud),
          shippingAud:       r.shipping_aud != null ? Number(r.shipping_aud) : null,
          totalAud:          Number(r.total_aud),
          deliveryMinDays:   r.delivery_min_days != null ? Number(r.delivery_min_days) : null,
          deliveryMaxDays:   r.delivery_max_days != null ? Number(r.delivery_max_days) : null,
          condition:         r.item_condition ?? null,
          sellerName:        r.seller_name ?? null,
          sellerFeedbackPct: r.seller_feedback_pct != null ? Number(r.seller_feedback_pct) : null,
          productUrl:        r.product_url ?? null,
          imageUrl:          r.image_url ?? null,
          location:          r.location ?? null,
        })),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}

// Store guard — return true to block. Not-found instead of 403 (don't
// leak the existence of a query the user shouldn't see).
function b_check(ctx: any, storeId: number | null): boolean {
  if (ctx.role === 'super_admin') return false
  if (storeId == null) return true
  return Number(storeId) !== Number(ctx.storeId)
}
