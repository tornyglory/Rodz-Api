import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import {
  QUOTE_SELECT, buildQuote, quoteError,
  getAllowedStoreIds, setQuoteItems, getQuoteItems,
} from './_helpers'
import { notifyStore } from '../shared/staffNotifications'

const ready = bootstrap()

// Statuses that lock item editing
const LOCKED_STATUSES = ['approved', 'invoiced', 'paid']

// Valid staff-initiated status transitions (draft→sent is handled by /send)
const VALID_TRANSITIONS: Record<string, string[]> = {
  sent:     ['rejected'],
  approved: ['invoiced'],
  invoiced: ['paid'],
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    // ── Fetch quote ────────────────────────────────────────────────────────
    const [[quote]] = await db.query<any[]>(
      'SELECT id, store_id, status, prepared_by_staff_id FROM quotes WHERE id = ? LIMIT 1',
      [id],
    )
    if (!quote) return quoteError(404, 'QUOTE_NOT_FOUND', 'Quote not found.')

    // ── Access check ───────────────────────────────────────────────────────
    const isOwner   = String(quote.prepared_by_staff_id) === String(ctx.staffId)
    const isManager = ctx.role === 'store_manager'
    const isAdmin   = ctx.role === 'super_admin'

    if (!isOwner && !isManager && !isAdmin) return forbidden()

    if (!isAdmin) {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(quote.store_id)) return forbidden()
    }

    // ── Parse body ─────────────────────────────────────────────────────────
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { status, notes, odometerIn, techId, items, bookingId } = body

    if (status === undefined && notes === undefined && odometerIn === undefined && techId === undefined && items === undefined && bookingId === undefined) {
      return validationError('No valid fields to update.')
    }

    // ── Status transition guard ────────────────────────────────────────────
    if (status != null) {
      const allowed = VALID_TRANSITIONS[quote.status] ?? []
      if (!allowed.includes(String(status))) {
        if (quote.status === 'draft' && status === 'sent') {
          return quoteError(409, 'USE_SEND_ENDPOINT', 'Use the /send endpoint to send a draft quote.')
        }
        return quoteError(409, 'INVALID_TRANSITION', `Cannot transition from "${quote.status}" to "${status}".`)
      }
    }

    // ── Item update guard ──────────────────────────────────────────────────
    if (items !== undefined && LOCKED_STATUSES.includes(quote.status)) {
      return quoteError(409, 'QUOTE_LOCKED', 'Items cannot be modified on an approved, invoiced, or paid quote.')
    }

    // ── Update items & recalc totals ───────────────────────────────────────
    let totals: { subtotal: number; gst: number; total: number } | null = null
    if (Array.isArray(items) && !LOCKED_STATUSES.includes(quote.status)) {
      totals = await setQuoteItems(db, Number(id), items)
    }

    // ── Build field updates ────────────────────────────────────────────────
    const updates: [string, unknown][] = []

    if (status != null)  updates.push(['status', status])
    if (notes !== undefined) updates.push(['internal_notes', notes])
    if (odometerIn !== undefined) updates.push(['odometer_in', odometerIn ?? null])
    if (techId !== undefined) updates.push(['prepared_by_staff_id', techId])
    if (bookingId !== undefined) updates.push(['booking_id', bookingId ?? null])
    if (totals) {
      updates.push(['subtotal', totals.subtotal])
      updates.push(['gst_amount', totals.gst])
      updates.push(['total', totals.total])
    }

    if (updates.length > 0) {
      const set    = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), id]
      await db.query<any>(`UPDATE quotes SET ${set} WHERE id = ?`, values)
    }

    // ── Create job card on approval ────────────────────────────────────────
    if (status === 'approved') {
      const [[linkedJob]] = await db.query<any[]>(
        `SELECT j.id, j.status FROM service_jobs j
         WHERE j.quote_id = ?
            OR j.booking_id = (SELECT booking_id FROM quotes WHERE id = ?)
         LIMIT 1`,
        [id, id],
      )
      if (linkedJob) {
        const [[alreadyExists]] = await db.query<any[]>(
          'SELECT id FROM job_card_items WHERE job_id = ? LIMIT 1',
          [linkedJob.id],
        )
        if (alreadyExists) {
          return quoteError(409, 'CARD_EXISTS', 'A job card already exists for this job.')
        }
        const [quoteLineItems] = await db.query<any[]>(
          'SELECT id, description, quantity, sort_order FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id',
          [id],
        )
        for (const li of quoteLineItems) {
          await db.query(
            `INSERT INTO job_card_items (job_id, quote_item_id, description, qty, sort_order, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [linkedJob.id, li.id, li.description, li.quantity, li.sort_order],
          )
        }
        if (linkedJob.status === 'awaiting_approval') {
          await db.query(
            `UPDATE service_jobs SET status = 'open', updated_at = NOW() WHERE id = ?`,
            [linkedJob.id],
          )
        }
      }
    }

    const [[row]] = await db.query<any[]>(`${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`, [id])
    const quoteItems = await getQuoteItems(db, Number(id))
    const result = buildQuote(row, quoteItems)

    if (status === 'approved') {
      await notifyStore(db, quote.store_id, {
        type:    'quote_approved',
        title:   'Quote Approved',
        body:    `${result.customerName} approved quote ${result.quoteNumber}`,
        quoteId: Number(id),
      })
    }

    return ok({ quote: result })
  } catch (err) {
    return serverError(err)
  }
}
