import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, badRequest, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId, staffId } = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const { customer_id, line_items, notes } = body

    if (!customer_id) return badRequest('customer_id is required')

    const [result] = await db.query<any>(
      `INSERT INTO quotes (customer_id, store_id, notes, created_by, status)
       VALUES (?, ?, ?, ?, 'draft')`,
      [customer_id, storeId, notes ?? null, staffId],
    )

    const quoteId = result.insertId

    if (Array.isArray(line_items) && line_items.length > 0) {
      const values = line_items.map((li: any) => [quoteId, li.description, li.quantity, li.unit_price])
      await db.query('INSERT INTO quote_line_items (quote_id, description, quantity, unit_price) VALUES ?', [values])
    }

    const [[quote], [items]] = await Promise.all([
      db.query<any[]>('SELECT * FROM quotes WHERE id = ? LIMIT 1', [quoteId]),
      db.query<any[]>('SELECT * FROM quote_line_items WHERE quote_id = ?', [quoteId]),
    ])

    return created({ ...quote[0], line_items: items })
  } catch (err) {
    return serverError(err)
  }
}
