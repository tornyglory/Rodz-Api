import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import {
  QUOTE_SELECT, buildQuote, quoteError,
  getAllowedStoreIds, setQuoteItems, getQuoteItems,
} from './_helpers'

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
    const { status, notes, techId, items } = body

    if (status === undefined && notes === undefined && techId === undefined && items === undefined) {
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
    if (techId !== undefined) updates.push(['prepared_by_staff_id', techId])
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

    const [[row]] = await db.query<any[]>(`${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`, [id])
    const quoteItems = await getQuoteItems(db, Number(id))
    return ok({ quote: buildQuote(row, quoteItems) })
  } catch (err) {
    return serverError(err)
  }
}
