import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { notFound, forbidden, serverError } from '../shared/errors'
import { invoiceError, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

const noContent = (): { statusCode: number; body: string } =>
  ({ statusCode: 204, body: '' })

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(
      'SELECT id, store_id, staff_id, status, job_id, quote_id FROM invoices WHERE id = ? LIMIT 1',
      [id],
    )
    if (!row) return notFound('Invoice')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return notFound('Invoice')
    }
    if (ctx.role === 'technician' && String(row.staff_id) !== String(ctx.staffId))
      return forbidden()

    if (row.status !== 'draft')
      return invoiceError(409, 'NOT_DRAFT', 'Only draft invoices can be deleted.')

    await db.query('DELETE FROM invoice_items WHERE invoice_id = ?', [id])
    await db.query('DELETE FROM invoices WHERE id = ?', [id])

    // Reset linked quote and job statuses
    if (row.quote_id) {
      await db.query(
        `UPDATE quotes SET status = 'approved' WHERE id = ? AND status = 'invoiced'`,
        [row.quote_id],
      )
    }
    if (row.job_id) {
      await db.query(
        `UPDATE service_jobs SET status = 'completed' WHERE id = ? AND status = 'invoiced'`,
        [row.job_id],
      )
    }

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
