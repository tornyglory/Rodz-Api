import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'
import { INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [id])
    if (!row) return notFound('Invoice')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return notFound('Invoice')
    }

    const itemsMap = await getInvoiceItems(db, [row.id])
    return ok({ invoice: buildInvoice(row, itemsMap.get(row.id) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
