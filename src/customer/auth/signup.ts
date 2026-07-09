import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import * as jwt from 'jsonwebtoken'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { created, validationError, serverError } from '../../shared/errors'
import { parseVehicle, buildCustomer, buildVehicleSummary } from '../_helpers'

const ready = bootstrap()

const VALID_STATES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { firstName, lastName, email, mobile, password, suburb, state, postcode } = body

    if (!firstName || !lastName || !email || !mobile || !password) {
      return validationError('firstName, lastName, email, mobile and password are required.')
    }
    if (String(password).length < 8) {
      return validationError('Password must be at least 8 characters.')
    }

    const emailStr    = String(email).trim().toLowerCase()
    const firstNameStr = String(firstName).trim()
    const lastNameStr  = String(lastName).trim()
    const mobileStr    = String(mobile).trim()
    const suburbStr    = suburb ? String(suburb).trim() : null
    const stateStr     = state  ? String(state).trim().toUpperCase() : null
    const postcodeStr  = postcode ? String(postcode).trim() : null

    if (stateStr && !VALID_STATES.has(stateStr)) {
      return validationError('Invalid state.')
    }

    // Check if email already exists
    const [[existing]] = await db.query<any[]>(
      `SELECT c.id, ca.id AS auth_id
       FROM customers c
       LEFT JOIN customer_auth ca ON ca.customer_id = c.id
       WHERE c.email = ? AND c.is_active = 1 LIMIT 1`,
      [emailStr],
    )

    if (existing?.auth_id) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists.' } }),
      }
    }

    const passwordHash = await bcrypt.hash(String(password), 12)

    let customerId: number

    if (existing?.id) {
      // Link auth to existing customer (previous workshop visit)
      customerId = existing.id
      // Update any missing fields
      await db.query(
        `UPDATE customers SET
           first_name = COALESCE(NULLIF(first_name, ''), ?),
           mobile     = COALESCE(NULLIF(mobile, ''), ?),
           suburb     = COALESCE(suburb, ?),
           state      = COALESCE(state, ?),
           postcode   = COALESCE(postcode, ?),
           updated_at = NOW()
         WHERE id = ?`,
        [firstNameStr, mobileStr, suburbStr, stateStr, postcodeStr, customerId],
      )
    } else {
      // Create new customer
      const [ins] = await db.query<any>(
        `INSERT INTO customers
           (first_name, last_name, email, mobile, store_id, suburb, state, postcode, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, NOW(), NOW())`,
        [firstNameStr, lastNameStr, emailStr, mobileStr, suburbStr, stateStr, postcodeStr],
      )
      customerId = ins.insertId
    }

    // Insert customer_auth
    await db.query(
      `INSERT INTO customer_auth (customer_id, password_hash, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())`,
      [customerId, passwordHash],
    )

    // Issue JWT (30 days)
    const exp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    const accessToken = jwt.sign({ sub: String(customerId), type: 'customer', exp }, process.env.JWT_SECRET!)

    // Persist session
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')
    const ip        = event.requestContext.http.sourceIp
    const userAgent = event.headers['user-agent'] ?? event.headers['User-Agent'] ?? 'unknown'

    await db.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, ip_address, user_agent, expires_at, created_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
      [customerId, tokenHash, ip, userAgent],
    )

    // Fetch customer to build response
    const [[customerRow]] = await db.query<any[]>(
      `SELECT id, first_name, last_name, email, mobile, suburb, state, postcode, description,
              date_of_birth, marketing_opt_in, sms_opt_in, avatar_image_id, created_at,
              onboarding_completed_at
       FROM customers WHERE id = ? LIMIT 1`,
      [customerId],
    )

    const [vehicleRows] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.make, v.model, v.year, v.avatar_image_id, v.cover_image_id, v.logbook_token
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id
       WHERE vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1`,
      [customerId],
    )

    const customer = buildCustomer(customerRow, vehicleRows.map(buildVehicleSummary))

    return created({ accessToken, customer })
  } catch (err) {
    return serverError(err)
  }
}
