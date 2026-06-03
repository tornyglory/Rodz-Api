import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildCustomerFull } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const updates: [string, unknown][] = []

    if (body.name != null) {
      const parts = String(body.name).trim().split(/\s+/)
      updates.push(['first_name', parts[0]], ['last_name', parts.slice(1).join(' ') || ''])
    }
    if (body.email != null) updates.push(['email',          String(body.email).trim()])
    if (body.phone != null) updates.push(['mobile',         String(body.phone).trim()])
    if (body.notes != null) updates.push(['internal_notes', body.notes])

    if (body.store != null) {
      const [[storeRow]] = await db.query<any[]>(
        'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
        [`%${String(body.store).trim()}%`],
      )
      if (!storeRow) return validationError(`Store "${body.store}" not found.`)
      updates.push(['store_id', storeRow.id])
    }

    if (updates.length === 0 && body.tag == null) return validationError('No valid fields to update.')

    if (updates.length > 0) {
      const set    = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), id]
      const [result] = await db.query<any>(`UPDATE customers SET ${set} WHERE id = ?`, values)
      if (result.affectedRows === 0) return notFound('Customer')
    }

    if (body.tag != null && ['New', 'Regular', 'VIP'].includes(String(body.tag))) {
      await db.query('DELETE FROM customer_tags WHERE customer_id = ?', [id])
      await db.query('INSERT INTO customer_tags (customer_id, tag) VALUES (?, ?)', [id, body.tag])
    }

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.internal_notes,
              st.name AS store_name
       FROM customers c JOIN stores st ON st.id = c.store_id
       WHERE c.id = ?`,
      [id],
    )
    if (!row) return notFound('Customer')

    const customer = await buildCustomerFull(db, row)
    return ok({ customer })
  } catch (err) {
    return serverError(err)
  }
}
