import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { sourceBookingParts } from './pipeline'

// GET  /bookings/{id}/parts-sourcing            — read latest snapshot
// POST /bookings/{id}/parts-sourcing/refresh    — re-run the pipeline
//
// Store-scoped for staff. Currently allows any staff role to trigger a
// refresh; the eBay call is read-only so there's no harm in
// technicians re-running to see fresh prices. Locked down further
// later if that changes.

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method = event.requestContext.http.method
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const bookingId = Number(event.pathParameters?.id)
  const isRefresh = /\/refresh$/.test(event.rawPath ?? '')

  if (!Number.isFinite(bookingId) || bookingId <= 0) return notFound('Booking')

  try {
    // Load booking + store guard
    const [[booking]] = await db.query<any[]>(
      `SELECT id, store_id, vehicle_id FROM bookings WHERE id = ? LIMIT 1`,
      [bookingId],
    )
    if (!booking) return notFound('Booking')
    if (ctx.role !== 'super_admin' && Number(booking.store_id) !== Number(ctx.storeId)) {
      return notFound('Booking')
    }

    if (method === 'POST' && isRefresh) {
      const result = await sourceBookingParts(db, bookingId)
      return ok({ refreshed: true, ...result, snapshot: await loadSnapshot(db, bookingId) })
    }
    if (method === 'GET' && !isRefresh) {
      return ok({ snapshot: await loadSnapshot(db, bookingId) })
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: '{}' }
  } catch (err) {
    return serverError(err)
  }
}

// Read the latest snapshot — one row per (booking, part) query with
// the top offerings nested inline. Sorted by cheapest total AUD so the
// workshop sees the best-value option per part at a glance.
async function loadSnapshot(db: any, bookingId: number) {
  const [queries] = await db.query(
    `SELECT q.id, q.vehicle_id, q.service_type_id, q.part_name_id,
            q.spec_hint, q.search_query, q.status, q.error, q.results_count,
            q.cheapest_total_aud, q.fastest_days_max,
            q.queried_at, q.completed_at,
            pn.name AS part_name, pn.category AS part_category,
            st.name AS service_name
     FROM part_sourcing_queries q
     JOIN part_names pn ON pn.id = q.part_name_id
     LEFT JOIN service_types st ON st.id = q.service_type_id
     WHERE q.booking_id = ?
     ORDER BY q.id ASC`,
    [bookingId],
  )

  const queryIds = queries.map((q: any) => Number(q.id))
  const offeringsByQuery = new Map<number, any[]>()
  if (queryIds.length) {
    const [offRows] = await db.query(
      `SELECT id, query_id, supplier, marketplace, external_id, title,
              price_native, currency, shipping_native, fx_rate,
              price_aud, shipping_aud, total_aud,
              delivery_min_days, delivery_max_days,
              item_condition, seller_name, seller_feedback_pct,
              product_url, image_url, location, captured_at
       FROM part_sourcing_offerings
       WHERE query_id IN (${queryIds.map(() => '?').join(',')})
       ORDER BY query_id, total_aud ASC`,
      queryIds,
    )
    for (const r of offRows) {
      const arr = offeringsByQuery.get(Number(r.query_id)) ?? []
      arr.push({
        id:               Number(r.id),
        supplier:         String(r.supplier),
        marketplace:      r.marketplace ?? null,
        externalId:       r.external_id ?? null,
        title:            String(r.title),
        priceNative:      Number(r.price_native),
        currency:         String(r.currency),
        shippingNative:   r.shipping_native != null ? Number(r.shipping_native) : null,
        fxRate:           Number(r.fx_rate),
        priceAud:         Number(r.price_aud),
        shippingAud:      r.shipping_aud != null ? Number(r.shipping_aud) : null,
        totalAud:         Number(r.total_aud),
        deliveryMinDays:  r.delivery_min_days != null ? Number(r.delivery_min_days) : null,
        deliveryMaxDays:  r.delivery_max_days != null ? Number(r.delivery_max_days) : null,
        condition:        r.item_condition ?? null,
        sellerName:       r.seller_name ?? null,
        sellerFeedbackPct: r.seller_feedback_pct != null ? Number(r.seller_feedback_pct) : null,
        productUrl:       r.product_url ?? null,
        imageUrl:         r.image_url ?? null,
        location:         r.location ?? null,
        capturedAt:       r.captured_at ? new Date(r.captured_at).toISOString() : null,
      })
      offeringsByQuery.set(Number(r.query_id), arr)
    }
  }

  const parts = queries.map((q: any) => ({
    queryId:           Number(q.id),
    partNameId:        Number(q.part_name_id),
    partName:          String(q.part_name),
    category:          String(q.part_category ?? 'Other'),
    serviceTypeId:     q.service_type_id != null ? Number(q.service_type_id) : null,
    serviceName:       q.service_name ?? null,
    specHint:          q.spec_hint ?? '',
    searchQuery:       String(q.search_query),
    status:            String(q.status),
    error:             q.error ?? null,
    resultsCount:      Number(q.results_count),
    cheapestTotalAud:  q.cheapest_total_aud != null ? Number(q.cheapest_total_aud) : null,
    fastestDaysMax:    q.fastest_days_max != null ? Number(q.fastest_days_max) : null,
    queriedAt:         q.queried_at ? new Date(q.queried_at).toISOString() : null,
    completedAt:       q.completed_at ? new Date(q.completed_at).toISOString() : null,
    offerings:         offeringsByQuery.get(Number(q.id)) ?? [],
  }))

  const anyCompleted = parts.some((p: any) => p.status === 'completed')
  return {
    bookingId,
    partCount:          parts.length,
    hasResults:         anyCompleted,
    lastQueriedAt:      parts.length ? parts[0].queriedAt : null,
    parts,
  }
}
