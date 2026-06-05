import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, serverError } from '../shared/errors'
import { quoteError, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

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

    // ── Only draft quotes can be deleted ───────────────────────────────────
    if (quote.status !== 'draft') {
      return quoteError(409, 'QUOTE_NOT_DELETABLE', 'Only draft quotes can be deleted.')
    }

    // ── Access check ───────────────────────────────────────────────────────
    const isOwner   = String(quote.prepared_by_staff_id) === String(ctx.staffId)
    const isManager = ctx.role === 'store_manager'
    const isAdmin   = ctx.role === 'super_admin'

    if (!isOwner && !isManager && !isAdmin) return forbidden()

    if (!isAdmin) {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(quote.store_id)) return forbidden()
    }

    // ── Delete items then quote ────────────────────────────────────────────
    await db.query('DELETE FROM quote_items WHERE quote_id = ?', [id])
    await db.query('DELETE FROM quotes WHERE id = ?', [id])

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
