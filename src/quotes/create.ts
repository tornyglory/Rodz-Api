import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import {
  QUOTE_SELECT, buildQuote, quoteError,
  getAllowedStoreIds, generateQuoteNumber, setQuoteItems, getQuoteItems,
} from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { customerId, vehicleId, notes, items, bookingId } = body
    let { storeId, techId } = body

    if (!customerId) return validationError('customerId is required.')
    if (!vehicleId)  return validationError('vehicleId is required.')

    if (!storeId) storeId = ctx.storeId
    if (!storeId) return validationError('storeId is required.')

    if (!techId) techId = ctx.staffId

    // ── Store access check ─────────────────────────────────────────────────
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(Number(storeId))) return forbidden()
    }

    // ── Verify customer ────────────────────────────────────────────────────
    const [[customerRow]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [customerId],
    )
    if (!customerRow) return quoteError(404, 'CUSTOMER_NOT_FOUND', 'No active customer with that ID exists.')

    // ── Verify vehicle belongs to customer ─────────────────────────────────
    const [[vehicleRow]] = await db.query<any[]>(
      `SELECT v.id FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE v.id = ? AND vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicleRow) return quoteError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found or does not belong to this customer.')

    // ── Generate quote number & insert ─────────────────────────────────────
    const quoteNumber = await generateQuoteNumber(db)

    const [result] = await db.query<any>(
      `INSERT INTO quotes
         (store_id, prepared_by_staff_id, customer_id, vehicle_id, quote_number, booking_id,
          status, valid_days, valid_until, internal_notes, subtotal, gst_amount, total)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 30, DATE_ADD(CURDATE(), INTERVAL 30 DAY), ?, 0, 0, 0)`,
      [storeId, techId, customerId, vehicleId, quoteNumber, bookingId ?? null, notes ?? null],
    )

    const quoteId: number = result.insertId

    // ── Optionally set items & update totals ───────────────────────────────
    if (Array.isArray(items) && items.length > 0) {
      const totals = await setQuoteItems(db, quoteId, items)
      await db.query(
        'UPDATE quotes SET subtotal = ?, gst_amount = ?, total = ? WHERE id = ?',
        [totals.subtotal, totals.gst, totals.total, quoteId],
      )
    }

    const [[row]] = await db.query<any[]>(`${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`, [quoteId])
    const quoteItems = await getQuoteItems(db, quoteId)
    return created({ quote: buildQuote(row, quoteItems) })
  } catch (err) {
    return serverError(err)
  }
}
