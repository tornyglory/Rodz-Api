import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, serverError } from '../../shared/errors'
import { getCustomerContext, buildCustomer, buildVehicleSummary } from '../_helpers'
import { safeGet, safeSetEx } from '../../shared/redis'

const ready = bootstrap()
const PROFILE_TTL_SEC = 900 // 15 min — invalidated on every PATCH /c/me

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const cacheKey = `customer:${ctx.customerId}:profile`
    const cached   = await safeGet<any>(cacheKey)
    if (cached) return ok(cached)

    const [[customerRow]] = await db.query<any[]>(
      `SELECT id, first_name, last_name, email, mobile, suburb, state, postcode, description,
              date_of_birth, gender, marketing_opt_in, sms_opt_in, avatar_image_id, created_at, is_premium, tier,
              onboarding_completed_at
       FROM customers WHERE id = ? AND is_active = 1 LIMIT 1`,
      [ctx.customerId],
    )
    if (!customerRow) return notFound('Customer')

    const [vehicleRows] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.make, v.model, v.year, v.avatar_image_id, v.cover_image_id, v.logbook_token
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [ctx.customerId],
    )

    const response = buildCustomer(customerRow, vehicleRows.map(buildVehicleSummary))
    await safeSetEx(cacheKey, PROFILE_TTL_SEC, response)
    return ok(response)
  } catch (err) {
    return serverError(err)
  }
}
