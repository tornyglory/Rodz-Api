import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildPart, PART_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const {
      partNumber, name, category, supplierId, supplierPartNumber,
      costPrice, sellPrice, gstApplicable, stockOnHand, reorderPoint,
    } = body

    const updates: [string, unknown][] = []
    if (partNumber !== undefined)          updates.push(['part_number', partNumber])
    if (name !== undefined)                updates.push(['name', name])
    if (category !== undefined)            updates.push(['category', category])
    if (supplierId !== undefined)          updates.push(['supplier_id', supplierId])
    if (supplierPartNumber !== undefined)  updates.push(['supplier_part_number', supplierPartNumber])
    if (costPrice !== undefined)           updates.push(['cost_price', costPrice])
    if (sellPrice !== undefined)           updates.push(['sell_price', sellPrice])
    if (gstApplicable !== undefined)       updates.push(['gst_applicable', gstApplicable ? 1 : 0])
    if (stockOnHand !== undefined)         updates.push(['stock_on_hand', stockOnHand])
    if (reorderPoint !== undefined)        updates.push(['reorder_point', reorderPoint])

    if (updates.length === 0) return validationError('At least one field is required.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(
      `UPDATE parts SET ${set} WHERE id = ? AND is_active = 1`,
      values,
    )
    if (result.affectedRows === 0) return notFound('Part')

    const [[row]] = await db.query<any[]>(
      `${PART_SELECT} WHERE p.id = ? LIMIT 1`,
      [id],
    )

    return ok({ part: buildPart(row) })
  } catch (err) {
    return serverError(err)
  }
}
