import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext, invalidateCustomerTier } from '../_helpers'
import { safeDel } from '../../shared/redis'

const ready = bootstrap()

const VALID_TIERS = new Set(['free', 'silver', 'gold'])

// Customer self-service tier change. No payment gate — beta period.
// When Stripe lands, checkout will call this same DB mutation via webhook.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const tier = typeof body.tier === 'string' ? body.tier : ''

    if (!VALID_TIERS.has(tier)) {
      return {
        statusCode: 400,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({ error: 'INVALID_TIER', message: "tier must be 'free' | 'silver' | 'gold'" }),
      }
    }

    await db.query('UPDATE customers SET tier = ? WHERE id = ?', [tier, ctx.customerId])

    // Invalidate both caches — subscription tier is checked on every
    // premium-gated endpoint (voice, hints, etc.), and the profile
    // response includes tier + isPremium.
    await invalidateCustomerTier(ctx.customerId)
    await safeDel(`customer:${ctx.customerId}:profile`)

    return ok({ tier, isPremium: tier !== 'free' })
  } catch (err) {
    return serverError(err)
  }
}
