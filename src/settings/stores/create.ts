import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { buildStore } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const { name, address = '', phone = '' } = JSON.parse(event.body ?? '{}')

    if (!name?.trim()) return validationError('name is required.')

    const [result] = await db.query<any>(
      'INSERT INTO stores (name, address_line1, suburb, state, postcode, phone) VALUES (?, ?, ?, ?, ?, ?)',
      [name.trim(), address, '', '', '', phone],
    )

    const store = await buildStore(db, result.insertId)
    return created({ store })
  } catch (err) {
    return serverError(err)
  }
}
