import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildSupplier, SUPPLIER_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, contactName, phone, email, website, accountNumber, notes } = body

    if (!name) return validationError('name is required.')

    const [result] = await db.query<any>(
      `INSERT INTO suppliers (name, contact_name, phone, email, website, account_number, notes, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, contactName ?? null, phone ?? null, email ?? null, website ?? null, accountNumber ?? null, notes ?? null],
    )

    const [[row]] = await db.query<any[]>(
      `${SUPPLIER_SELECT} WHERE id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ supplier: buildSupplier(row) })
  } catch (err) {
    return serverError(err)
  }
}
