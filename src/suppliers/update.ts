import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildSupplier, SUPPLIER_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, contactName, phone, email, website, accountNumber, notes } = body

    const updates: [string, unknown][] = []
    if (name !== undefined)          updates.push(['name', name])
    if (contactName !== undefined)   updates.push(['contact_name', contactName])
    if (phone !== undefined)         updates.push(['phone', phone])
    if (email !== undefined)         updates.push(['email', email])
    if (website !== undefined)       updates.push(['website', website])
    if (accountNumber !== undefined) updates.push(['account_number', accountNumber])
    if (notes !== undefined)         updates.push(['notes', notes])

    if (updates.length === 0) return validationError('At least one field is required.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(
      `UPDATE suppliers SET ${set} WHERE id = ? AND is_active = 1`,
      values,
    )
    if (result.affectedRows === 0) return notFound('Supplier')

    const [[row]] = await db.query<any[]>(
      `${SUPPLIER_SELECT} WHERE id = ? LIMIT 1`,
      [id],
    )

    return ok({ supplier: buildSupplier(row) })
  } catch (err) {
    return serverError(err)
  }
}
