import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, notFound, serverError } from '../../shared/errors'
import { getCustomerContext, buildCustomer, buildVehicleSummary } from '../_helpers'
import { safeDel } from '../../shared/redis'

const ready = bootstrap()

const VALID_STATES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const {
      firstName, lastName, mobile, suburb, state, postcode, description,
      dateOfBirth, gender, marketingOptIn, smsOptIn,
      dreamCar, favouriteDrive, drivingSinceYear,
    } = body

    if (state != null && !VALID_STATES.has(String(state).toUpperCase())) {
      return validationError('Invalid state.')
    }
    if (dateOfBirth != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateOfBirth))) {
      return validationError('dateOfBirth must be in YYYY-MM-DD format.')
    }
    if (gender != null && !['male', 'female', 'other'].includes(String(gender))) {
      return validationError('gender must be male, female, or other.')
    }
    if (description != null && String(description).length > 2000) {
      return validationError('description must be 2000 characters or fewer.')
    }
    if (dreamCar != null && String(dreamCar).length > 100) {
      return validationError('dreamCar must be 100 characters or fewer.')
    }
    if (favouriteDrive != null && String(favouriteDrive).length > 200) {
      return validationError('favouriteDrive must be 200 characters or fewer.')
    }
    if (drivingSinceYear != null && drivingSinceYear !== '') {
      const y = Number(drivingSinceYear)
      const nowYear = new Date().getUTCFullYear()
      if (!Number.isInteger(y) || y < 1900 || y > nowYear) {
        return validationError(`drivingSinceYear must be an integer between 1900 and ${nowYear}.`)
      }
    }

    const sets: string[] = ['updated_at = NOW()']
    const params: any[]  = []

    if (firstName     != null) { sets.push('first_name = ?');       params.push(String(firstName).trim()) }
    if (lastName      != null) { sets.push('last_name = ?');        params.push(String(lastName).trim()) }
    if (mobile        != null) { sets.push('mobile = ?');           params.push(String(mobile).trim()) }
    if (suburb        != null) { sets.push('suburb = ?');           params.push(String(suburb).trim() || null) }
    if (state         != null) { sets.push('state = ?');            params.push(String(state).trim().toUpperCase()) }
    if (postcode      != null) { sets.push('postcode = ?');         params.push(String(postcode).trim() || null) }
    if (description   != null) { sets.push('description = ?');      params.push(String(description).trim() || null) }
    if (dateOfBirth   != null) { sets.push('date_of_birth = ?');    params.push(String(dateOfBirth) || null) }
    if (gender        != null) { sets.push('gender = ?');           params.push(String(gender)) }
    if (marketingOptIn != null) { sets.push('marketing_opt_in = ?'); params.push(marketingOptIn ? 1 : 0) }
    if (smsOptIn      != null) { sets.push('sms_opt_in = ?');       params.push(smsOptIn ? 1 : 0) }
    // Explicit `null`/empty-string clears — String() would coerce to
    // "null" / "" which isn't what we want on nullable columns.
    if ('dreamCar' in body) {
      sets.push('dream_car = ?')
      params.push(dreamCar === null || dreamCar === '' ? null : String(dreamCar).trim())
    }
    if ('favouriteDrive' in body) {
      sets.push('favourite_drive = ?')
      params.push(favouriteDrive === null || favouriteDrive === '' ? null : String(favouriteDrive).trim())
    }
    if ('drivingSinceYear' in body) {
      sets.push('driving_since_year = ?')
      params.push(drivingSinceYear === null || drivingSinceYear === '' ? null : Number(drivingSinceYear))
    }

    if (params.length > 0) {
      params.push(ctx.customerId)
      await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, params)
      await safeDel(`customer:${ctx.customerId}:profile`)
    }

    const [[customerRow]] = await db.query<any[]>(
      `SELECT id, first_name, last_name, email, mobile, suburb, state, postcode, description,
              date_of_birth, gender, marketing_opt_in, sms_opt_in, avatar_image_id, cover_image_id,
              dream_car, favourite_drive, driving_since_year, created_at
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

    return ok(buildCustomer(customerRow, vehicleRows.map(buildVehicleSummary)))
  } catch (err) {
    return serverError(err)
  }
}
