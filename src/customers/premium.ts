import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body      = JSON.parse(event.body ?? '{}')
    const isPremium = body.isPremium === true || body.isPremium === 1 ? 1 : 0

    const [result] = await db.query<any>(
      'UPDATE customers SET is_premium = ? WHERE id = ?',
      [isPremium, id],
    )
    if (result.affectedRows === 0) return notFound('Customer')

    return ok({ id: Number(id), isPremium: isPremium === 1 })
  } catch (err) {
    return serverError(err)
  }
}
