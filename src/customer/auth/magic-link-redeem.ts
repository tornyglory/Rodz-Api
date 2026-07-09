import * as crypto from 'crypto'
import * as jwt from 'jsonwebtoken'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, serverError } from '../../shared/errors'
import { buildCustomer, buildVehicleSummary } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    const token = event.pathParameters?.token
    if (!token) return notFound('Token')

    const db = getPool()

    const [[row]] = await db.query<any[]>(
      `SELECT ca.customer_id
       FROM customer_auth ca
       WHERE ca.magic_link_token = ? AND ca.magic_link_expires_at > NOW() LIMIT 1`,
      [token],
    )

    if (!row) return notFound('Token')

    // Invalidate the token immediately
    await db.query(
      'UPDATE customer_auth SET magic_link_token = NULL, magic_link_expires_at = NULL WHERE customer_id = ?',
      [row.customer_id],
    )

    const exp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    const accessToken = jwt.sign({ sub: String(row.customer_id), type: 'customer', exp }, process.env.JWT_SECRET!)

    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')
    const ip        = event.requestContext.http.sourceIp
    const userAgent = event.headers['user-agent'] ?? event.headers['User-Agent'] ?? 'unknown'

    await db.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, ip_address, user_agent, expires_at, created_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
      [row.customer_id, tokenHash, ip, userAgent],
    )

    const [[customerRow]] = await db.query<any[]>(
      `SELECT id, first_name, last_name, email, mobile, suburb, state, postcode, description,
              date_of_birth, gender, marketing_opt_in, sms_opt_in, avatar_image_id, created_at, is_premium,
              onboarding_completed_at
       FROM customers WHERE id = ? AND is_active = 1 LIMIT 1`,
      [row.customer_id],
    )
    if (!customerRow) return notFound('Customer')

    const [vehicleRows] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.make, v.model, v.year, v.avatar_image_id, v.cover_image_id, v.logbook_token
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1
       ORDER BY v.make, v.model`,
      [row.customer_id],
    )

    const customer = buildCustomer(customerRow, vehicleRows.map(buildVehicleSummary))

    return ok({ accessToken, customer })
  } catch (err) {
    return serverError(err)
  }
}
