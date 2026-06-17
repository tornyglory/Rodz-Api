import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import {
  INVOICE_SELECT, INVOICE_FROM,
  buildInvoice, getInvoiceItems, getAllowedStoreIds,
} from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const qs  = event.queryStringParameters ?? {}

  try {
    const conditions: string[] = []
    const params:     any[]    = []

    // Store access
    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.length) return ok({ invoices: [] })
      conditions.push(`i.store_id IN (${allowedIds.map(() => '?').join(',')})`)
      params.push(...allowedIds)
    } else if (qs.store && qs.store !== 'all') {
      conditions.push('s.name LIKE ?')
      params.push(`%${qs.store}%`)
    }

    if (qs.status) {
      conditions.push('i.status = ?')
      params.push(qs.status)
    }

    if (qs.customerId) {
      conditions.push('i.customer_id = ?')
      params.push(Number(qs.customerId))
    }

    if (qs.search) {
      conditions.push(`(
        CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR
        i.vehicle_rego LIKE ? OR
        i.invoice_number LIKE ?
      )`)
      const like = `%${qs.search}%`
      params.push(like, like, like)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await db.query<any[]>(
      `${INVOICE_SELECT} ${INVOICE_FROM} ${where} ORDER BY i.id DESC`,
      params,
    )

    const ids = rows.map((r: any) => r.id)
    const itemsMap = await getInvoiceItems(db, ids)

    const invoices = rows.map((r: any) => buildInvoice(r, itemsMap.get(r.id) ?? []))
    return ok({ invoices })
  } catch (err) {
    return serverError(err)
  }
}
