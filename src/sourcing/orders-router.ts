import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, validationError, serverError } from '../shared/errors'
import { syncJobStatusFromOrders } from './jobStatusSync'

type Pool = mysql.Pool

// Part orders — records of actual purchases the workshop has made for a
// booking's parts, whether via a manual buy-and-paste flow (v1) or an
// automated API-driven placement (later).
//
//   GET   /bookings/{id}/parts-orders              — list orders for a booking
//   POST  /bookings/{id}/parts-orders              — create a new order (from offering, or free-form)
//   PATCH /parts-orders/{orderId}                  — update status / tracking / arrived_at
//   DELETE /parts-orders/{orderId}                 — cancel (or mark returned)

const ready = bootstrap()
const VALID_STATUSES = new Set(['placed','confirmed','shipped','arrived','cancelled','returned','not_arrived'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method = event.requestContext.http.method
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const path   = event.rawPath ?? ''

  try {
    // /bookings/{id}/parts-orders
    if (/\/bookings\/\d+\/parts-orders$/.test(path)) {
      const bookingId = Number(event.pathParameters?.id)
      if (!Number.isFinite(bookingId) || bookingId <= 0) return notFound('Booking')

      const [[booking]] = await db.query<any[]>('SELECT id, store_id FROM bookings WHERE id = ? LIMIT 1', [bookingId])
      if (!booking) return notFound('Booking')
      if (ctx.role !== 'super_admin' && Number(booking.store_id) !== Number(ctx.storeId)) return notFound('Booking')

      if (method === 'GET')  return await listOrders(db, bookingId)
      if (method === 'POST') return await createOrder(db, bookingId, JSON.parse(event.body ?? '{}'), ctx)
    }

    // /parts-orders/{orderId}
    if (/\/parts-orders\/\d+$/.test(path)) {
      const orderId = Number(event.pathParameters?.orderId)
      if (!Number.isFinite(orderId) || orderId <= 0) return notFound('Order')

      const [[order]] = await db.query<any[]>(
        `SELECT o.*, b.store_id
         FROM part_orders o
         JOIN bookings b ON b.id = o.booking_id
         WHERE o.id = ? LIMIT 1`,
        [orderId],
      )
      if (!order) return notFound('Order')
      if (ctx.role !== 'super_admin' && Number(order.store_id) !== Number(ctx.storeId)) return notFound('Order')

      if (method === 'PATCH')  return await updateOrder(db, orderId, JSON.parse(event.body ?? '{}'))
      if (method === 'DELETE') return await deleteOrder(db, orderId)
    }

    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: '{}' }
  } catch (err) {
    return serverError(err)
  }
}

// ─── list ──────────────────────────────────────────────────────────────────

async function listOrders(db: Pool, bookingId: number): Promise<APIGatewayProxyResultV2> {
  const [rows] = await db.query<any[]>(
    `SELECT o.*,
            pn.name AS part_name, pn.category AS part_category,
            s.first_name AS placed_by_first, s.last_name AS placed_by_last
     FROM part_orders o
     JOIN part_names pn ON pn.id = o.part_name_id
     LEFT JOIN staff s ON s.id = o.placed_by_staff_id
     WHERE o.booking_id = ?
     ORDER BY o.placed_at DESC, o.id DESC`,
    [bookingId],
  )
  return ok({ orders: rows.map(shapeOrder) })
}

// ─── create ────────────────────────────────────────────────────────────────

async function createOrder(db: Pool, bookingId: number, body: any, ctx: any): Promise<APIGatewayProxyResultV2> {
  if (ctx.role === 'technician') return forbidden()

  // Two shapes:
  //   { offeringId, externalOrderId?, notes? }
  //     — pre-populates most fields from the sourcing snapshot
  //   { partNameId, supplier, itemTitle, priceNative, currency, ... }
  //     — free-form (walk-in from another supplier, manual entry)
  let payload: any = {}
  if (body.offeringId) {
    const [[off]] = await db.query<any[]>(
      `SELECT o.*, q.part_name_id, q.spec_hint
       FROM part_sourcing_offerings o
       JOIN part_sourcing_queries   q ON q.id = o.query_id
       WHERE o.id = ? LIMIT 1`,
      [body.offeringId],
    )
    if (!off) return validationError('offeringId does not exist')

    payload = {
      offeringId:           Number(off.id),
      partNameId:           Number(off.part_name_id),
      supplier:             String(off.supplier),
      marketplace:          off.marketplace ?? null,
      externalOrderId:      body.externalOrderId ? String(body.externalOrderId).slice(0, 120) : null,
      externalOrderUrl:     off.product_url ?? null,
      itemTitle:            String(off.title).slice(0, 500),
      quantity:             body.quantity ? Number(body.quantity) : 1,
      priceNative:          Number(off.price_native),
      currency:             String(off.currency),
      shippingNative:       off.shipping_native != null ? Number(off.shipping_native) : null,
      totalAud:             Number(off.total_aud),
      expectedDelivery:     computeExpectedDelivery(off.delivery_max_days),
      notes:                body.notes ? String(body.notes).slice(0, 500) : null,
    }
  } else {
    if (!body.partNameId || !body.supplier || !body.itemTitle || body.priceNative == null || !body.currency) {
      return validationError('Provide { offeringId } OR all of { partNameId, supplier, itemTitle, priceNative, currency }')
    }
    payload = {
      offeringId:           null,
      partNameId:           Number(body.partNameId),
      supplier:             String(body.supplier),
      marketplace:          body.marketplace ? String(body.marketplace) : null,
      externalOrderId:      body.externalOrderId ? String(body.externalOrderId).slice(0, 120) : null,
      externalOrderUrl:     body.externalOrderUrl ? String(body.externalOrderUrl).slice(0, 800) : null,
      itemTitle:            String(body.itemTitle).slice(0, 500),
      quantity:             body.quantity ? Number(body.quantity) : 1,
      priceNative:          Number(body.priceNative),
      currency:             String(body.currency).slice(0, 10),
      shippingNative:       body.shippingNative != null ? Number(body.shippingNative) : null,
      totalAud:             body.totalAud != null ? Number(body.totalAud) : Number(body.priceNative),
      expectedDelivery:     body.expectedDelivery ? String(body.expectedDelivery).slice(0, 10) : null,
      notes:                body.notes ? String(body.notes).slice(0, 500) : null,
    }
  }

  const [ins] = await db.query<any[]>(
    `INSERT INTO part_orders
       (booking_id, offering_id, part_name_id, supplier, marketplace,
        external_order_id, external_order_url, item_title, quantity,
        price_paid_native, currency, shipping_paid_native, total_paid_aud,
        expected_delivery, placed_by_staff_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bookingId, payload.offeringId, payload.partNameId, payload.supplier, payload.marketplace,
      payload.externalOrderId, payload.externalOrderUrl, payload.itemTitle, payload.quantity,
      payload.priceNative, payload.currency, payload.shippingNative, payload.totalAud,
      payload.expectedDelivery, Number(ctx.staffId), payload.notes,
    ],
  )
  const orderId = Number((ins as any).insertId)

  // Any newly-placed order that's not immediately `arrived` should
  // flag the job as awaiting parts. Fire-and-forget (never fails the
  // create, and the job sync is idempotent).
  await syncJobStatusFromOrders(db, bookingId).catch(err =>
    console.error('[parts-orders] job sync (create) failed:', err))

  const [[fresh]] = await db.query<any[]>(
    `SELECT o.*, pn.name AS part_name, pn.category AS part_category,
            s.first_name AS placed_by_first, s.last_name AS placed_by_last
     FROM part_orders o
     JOIN part_names pn ON pn.id = o.part_name_id
     LEFT JOIN staff s ON s.id = o.placed_by_staff_id
     WHERE o.id = ?`,
    [orderId],
  )
  return ok({ order: shapeOrder(fresh) })
}

// ─── update ────────────────────────────────────────────────────────────────

async function updateOrder(db: Pool, orderId: number, body: any): Promise<APIGatewayProxyResultV2> {
  const sets: string[] = []
  const params: any[] = []

  if (body.status != null) {
    if (!VALID_STATUSES.has(String(body.status))) return validationError(`status must be one of ${[...VALID_STATUSES].join(', ')}`)
    sets.push('status = ?'); params.push(String(body.status))
    // Convenience — flip arrived_at automatically when status → arrived.
    if (body.status === 'arrived' && body.arrivedAt == null) {
      sets.push('arrived_at = COALESCE(arrived_at, CURDATE())')
    }
  }
  if (body.externalOrderId    !== undefined) { sets.push('external_order_id = ?');    params.push(body.externalOrderId    ? String(body.externalOrderId).slice(0, 120)    : null) }
  if (body.externalOrderUrl   !== undefined) { sets.push('external_order_url = ?');   params.push(body.externalOrderUrl   ? String(body.externalOrderUrl).slice(0, 800)   : null) }
  if (body.trackingNumber     !== undefined) { sets.push('tracking_number = ?');      params.push(body.trackingNumber     ? String(body.trackingNumber).slice(0, 120)     : null) }
  if (body.trackingCarrier    !== undefined) { sets.push('tracking_carrier = ?');     params.push(body.trackingCarrier    ? String(body.trackingCarrier).slice(0, 60)     : null) }
  if (body.expectedDelivery   !== undefined) { sets.push('expected_delivery = ?');    params.push(body.expectedDelivery   ? String(body.expectedDelivery).slice(0, 10)    : null) }
  if (body.arrivedAt          !== undefined) { sets.push('arrived_at = ?');           params.push(body.arrivedAt          ? String(body.arrivedAt).slice(0, 10)           : null) }
  if (body.notes              !== undefined) { sets.push('notes = ?');                params.push(body.notes              ? String(body.notes).slice(0, 500)              : null) }

  if (sets.length === 0) return validationError('No fields to update')

  params.push(orderId)
  await db.query<any[]>(`UPDATE part_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params)

  // Sync job status — arrival ticks may flip the job back to `open`,
  // cancellations may leave the job awaiting the remaining orders.
  const [[after]] = await db.query<any[]>('SELECT booking_id FROM part_orders WHERE id = ? LIMIT 1', [orderId])
  if (after?.booking_id) {
    await syncJobStatusFromOrders(db, Number(after.booking_id)).catch(err =>
      console.error('[parts-orders] job sync (update) failed:', err))
  }

  const [[fresh]] = await db.query<any[]>(
    `SELECT o.*, pn.name AS part_name, pn.category AS part_category,
            s.first_name AS placed_by_first, s.last_name AS placed_by_last
     FROM part_orders o
     JOIN part_names pn ON pn.id = o.part_name_id
     LEFT JOIN staff s ON s.id = o.placed_by_staff_id
     WHERE o.id = ?`,
    [orderId],
  )
  return ok({ order: shapeOrder(fresh) })
}

// ─── delete ────────────────────────────────────────────────────────────────

async function deleteOrder(db: Pool, orderId: number): Promise<APIGatewayProxyResultV2> {
  const [[row]] = await db.query<any[]>('SELECT booking_id FROM part_orders WHERE id = ? LIMIT 1', [orderId])
  await db.query<any[]>('DELETE FROM part_orders WHERE id = ?', [orderId])
  if (row?.booking_id) {
    await syncJobStatusFromOrders(db, Number(row.booking_id)).catch(err =>
      console.error('[parts-orders] job sync (delete) failed:', err))
  }
  return ok({ deleted: true })
}

// ─── helpers ───────────────────────────────────────────────────────────────

function shapeOrder(r: any) {
  return {
    id:                  Number(r.id),
    bookingId:           Number(r.booking_id),
    serviceJobId:        r.service_job_id != null ? Number(r.service_job_id) : null,
    offeringId:          r.offering_id != null ? Number(r.offering_id) : null,
    partNameId:          Number(r.part_name_id),
    partName:            String(r.part_name),
    partCategory:        String(r.part_category ?? 'Other'),
    supplier:            String(r.supplier),
    marketplace:         r.marketplace ?? null,
    externalOrderId:     r.external_order_id ?? null,
    externalOrderUrl:    r.external_order_url ?? null,
    itemTitle:           String(r.item_title),
    quantity:            Number(r.quantity),
    priceNative:         Number(r.price_paid_native),
    currency:            String(r.currency),
    shippingNative:      r.shipping_paid_native != null ? Number(r.shipping_paid_native) : null,
    totalAud:            Number(r.total_paid_aud),
    status:              String(r.status),
    expectedDelivery:    r.expected_delivery ? String(r.expected_delivery).slice(0, 10) : null,
    arrivedAt:           r.arrived_at ? String(r.arrived_at).slice(0, 10) : null,
    trackingNumber:      r.tracking_number ?? null,
    trackingCarrier:     r.tracking_carrier ?? null,
    placedByStaffId:     Number(r.placed_by_staff_id),
    placedBy:            r.placed_by_first ? `${r.placed_by_first} ${r.placed_by_last ?? ''}`.trim() : null,
    placedAt:            r.placed_at ? new Date(r.placed_at).toISOString() : null,
    notes:               r.notes ?? null,
  }
}

function computeExpectedDelivery(maxDays: number | null): string | null {
  if (maxDays == null || !Number.isFinite(Number(maxDays))) return null
  const d = new Date()
  d.setDate(d.getDate() + Number(maxDays))
  return d.toISOString().slice(0, 10)
}
