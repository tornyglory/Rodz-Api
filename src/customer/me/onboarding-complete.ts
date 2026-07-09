import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    // COALESCE preserves the original completion time when called twice
    // (idempotent — useful for later "time to onboard" analytics).
    await db.query(
      `UPDATE customers
         SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
       WHERE id = ? AND is_active = 1`,
      [ctx.customerId],
    )

    const [[row]] = await db.query<any[]>(
      'SELECT onboarding_completed_at FROM customers WHERE id = ? LIMIT 1',
      [ctx.customerId],
    )
    if (!row) return notFound('Customer')

    const raw = row.onboarding_completed_at
    const iso = raw ? (raw instanceof Date ? raw : new Date(raw)).toISOString() : null

    return ok({ onboardingCompletedAt: iso })
  } catch (err) {
    return serverError(err)
  }
}
