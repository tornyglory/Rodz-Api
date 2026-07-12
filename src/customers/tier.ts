import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'

const ready = bootstrap()

const VALID_TIERS = new Set(['free', 'silver', 'gold'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as { tier?: unknown }
    const tier = typeof body.tier === 'string' ? body.tier : ''
    if (!VALID_TIERS.has(tier)) {
      return validationError("tier must be 'free', 'silver' or 'gold'.")
    }

    const isPremium = tier === 'free' ? 0 : 1
    const [result] = await db.query<any>(
      'UPDATE customers SET tier = ?, is_premium = ?, updated_at = NOW() WHERE id = ?',
      [tier, isPremium, id],
    )
    if (result.affectedRows === 0) return notFound('Customer')

    return ok({ id: Number(id), tier, isPremium: isPremium === 1 })
  } catch (err) {
    return serverError(err)
  }
}
