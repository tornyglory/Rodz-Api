import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, serverError } from '../shared/errors'
import { buildCustomerFull } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const params: unknown[] = [id]
    let storeFilter = ''
    if (ctx.role !== 'super_admin') {
      storeFilter = ' AND c.store_id = ?'
      params.push(ctx.storeId)
    }

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.internal_notes,
              c.date_of_birth, c.address_line1, c.address_line2, c.suburb, c.state, c.postcode,
              st.name AS store_name
       FROM customers c
       JOIN stores st ON st.id = c.store_id
       WHERE c.id = ? AND c.is_active = 1${storeFilter}
       LIMIT 1`,
      params,
    )
    if (!row) return notFound('Customer')

    const customer = await buildCustomerFull(db, row)
    return ok({ customer })
  } catch (err) {
    return serverError(err)
  }
}
