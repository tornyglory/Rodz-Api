import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildPart, PART_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const {
      partNumber, name, category, supplierId, supplierPartNumber,
      costPrice, sellPrice, gstApplicable, stockOnHand, reorderPoint,
    } = body

    if (!partNumber)             return validationError('partNumber is required.')
    if (!name)                   return validationError('name is required.')
    if (costPrice == null)       return validationError('costPrice is required.')
    if (sellPrice == null)       return validationError('sellPrice is required.')

    const [result] = await db.query<any>(
      `INSERT INTO parts
         (part_number, name, category, supplier_id, supplier_part_number,
          cost_price, sell_price, gst_applicable, stock_on_hand, reorder_point, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        partNumber, name, category ?? null, supplierId ?? null, supplierPartNumber ?? null,
        costPrice, sellPrice, gstApplicable === false ? 0 : 1,
        stockOnHand ?? 0, reorderPoint ?? 0,
      ],
    )

    const [[row]] = await db.query<any[]>(
      `${PART_SELECT} WHERE p.id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ part: buildPart(row) })
  } catch (err) {
    return serverError(err)
  }
}
