import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { safeDel } from '../../shared/redis'
import { getPool } from '../../shared/db'
import { ok, validationError, forbidden, notFound, serverError } from '../../shared/errors'
import { getCustomerContext, buildVehicle } from '../_helpers'
import { maybeRegenerateSchedule } from '../../shared/aiEngines'
import { bumpOdometer } from '../../shared/odometer'

const ready = bootstrap()

// Enum whitelists mirror the DB column definitions. Case-insensitive on
// input, lower-cased on storage so the DB accepts them.
const BODY_TYPES    = new Set(['sedan','hatch','wagon','ute','van','suv','coupe','convertible','truck','other'])
const FUEL_TYPES    = new Set(['petrol','diesel','hybrid','electric','lpg','other'])
const TRANSMISSIONS = new Set(['manual','automatic','cvt','dct','other'])
const DRIVE_TYPES   = new Set(['fwd','rwd','awd','4wd'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const {
      // Existing fields
      colour, regoExpiry, vin, odometerKm, description,
      // Identifiers (customer may correct an initial AI-parse miss)
      make, model, series, year,
      // Engine + drivetrain
      engineCode, engineSizeCC, cylinders,
      bodyType, fuelType, transmission, driveType,
      // Tyres
      tyreSizeFront, tyreSizeRear,
    } = body

    // ── Validation ────────────────────────────────────────────────────────
    if (regoExpiry != null && regoExpiry !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(regoExpiry))) {
      return validationError('regoExpiry must be in YYYY-MM-DD format.')
    }
    if (odometerKm != null && (isNaN(Number(odometerKm)) || Number(odometerKm) < 0)) {
      return validationError('odometerKm must be a non-negative number.')
    }
    if (description != null && String(description).length > 2000) {
      return validationError('description must be 2000 characters or fewer.')
    }
    if (year != null && year !== '') {
      const n = Number(year)
      if (!Number.isInteger(n) || n < 1900 || n > 2100) {
        return validationError('year must be an integer between 1900 and 2100.')
      }
    }
    if (engineSizeCC != null && engineSizeCC !== '') {
      const n = Number(engineSizeCC)
      if (!Number.isInteger(n) || n < 1 || n > 32767) {
        return validationError('engineSizeCC must be a positive integer (in cc, up to 32767).')
      }
    }
    if (cylinders != null && cylinders !== '') {
      const n = Number(cylinders)
      if (!Number.isInteger(n) || n < 1 || n > 16) {
        return validationError('cylinders must be an integer between 1 and 16.')
      }
    }
    if (bodyType != null && bodyType !== '' && !BODY_TYPES.has(String(bodyType).toLowerCase())) {
      return validationError(`bodyType must be one of: ${[...BODY_TYPES].join(', ')}.`)
    }
    if (fuelType != null && fuelType !== '' && !FUEL_TYPES.has(String(fuelType).toLowerCase())) {
      return validationError(`fuelType must be one of: ${[...FUEL_TYPES].join(', ')}.`)
    }
    if (transmission != null && transmission !== '' && !TRANSMISSIONS.has(String(transmission).toLowerCase())) {
      return validationError(`transmission must be one of: ${[...TRANSMISSIONS].join(', ')}.`)
    }
    if (driveType != null && driveType !== '' && !DRIVE_TYPES.has(String(driveType).toLowerCase())) {
      return validationError(`driveType must be one of: ${[...DRIVE_TYPES].join(', ')}.`)
    }
    // Identifiers are NOT NULL in the DB — reject empty-string clears.
    if (make  != null && !String(make).trim())  return validationError('make cannot be empty.')
    if (model != null && !String(model).trim()) return validationError('model cannot be empty.')

    // ── Build UPDATE ──────────────────────────────────────────────────────
    const sets: string[] = ['updated_at = NOW()']
    const params: any[]  = []

    // Nullable strings — empty string clears to NULL
    if (colour      != null) { sets.push('colour = ?');           params.push(String(colour).trim()      || null) }
    if (regoExpiry  != null) { sets.push('rego_expiry = ?');      params.push(String(regoExpiry)        || null) }
    if (vin         != null) { sets.push('vin = ?');              params.push(String(vin).trim().toUpperCase() || null) }
    if (description != null) { sets.push('description = ?');      params.push(String(description).trim() || null) }
    if (series      != null) { sets.push('series = ?');           params.push(String(series).trim()     || null) }
    if (engineCode  != null) { sets.push('engine_code = ?');      params.push(String(engineCode).trim() || null) }
    if (tyreSizeFront != null) { sets.push('tyre_size_front = ?'); params.push(String(tyreSizeFront).trim() || null) }
    if (tyreSizeRear  != null) { sets.push('tyre_size_rear = ?');  params.push(String(tyreSizeRear).trim()  || null) }

    // Nullable numbers — empty string clears to NULL
    if (engineSizeCC != null) { sets.push('engine_size_cc = ?'); params.push(engineSizeCC === '' ? null : Number(engineSizeCC)) }
    if (cylinders    != null) { sets.push('cylinders = ?');      params.push(cylinders    === '' ? null : Number(cylinders)) }

    // Nullable enums — empty string clears to NULL; whitelisted above
    if (bodyType  != null) { sets.push('body_type = ?');  params.push(bodyType  === '' ? null : String(bodyType).toLowerCase()) }
    if (driveType != null) { sets.push('drive_type = ?'); params.push(driveType === '' ? null : String(driveType).toLowerCase()) }

    // NOT NULL identifiers — only update if a real value is provided
    if (make  != null && String(make).trim())  { sets.push('make = ?');  params.push(String(make).trim()) }
    if (model != null && String(model).trim()) { sets.push('model = ?'); params.push(String(model).trim()) }
    if (year  != null && year !== '')          { sets.push('year = ?');  params.push(Number(year)) }

    // NOT NULL enums with DB defaults — only update if a real value is provided
    if (fuelType     != null && fuelType     !== '') { sets.push('fuel_type = ?');    params.push(String(fuelType).toLowerCase()) }
    if (transmission != null && transmission !== '') { sets.push('transmission = ?'); params.push(String(transmission).toLowerCase()) }

    if (odometerKm != null) {
      const bump = await bumpOdometer(db, vehicleId, Number(odometerKm), 'customer')
      if (!bump.ok && bump.reason === 'backwards') {
        return validationError(`odometerKm cannot decrease. Previous reading was ${bump.previous.toLocaleString()} km.`)
      }
      if (!bump.ok && bump.reason === 'not_found') return notFound('Vehicle')
    }

    if (params.length > 0) {
      params.push(vehicleId)
      await db.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`, params)
    }

    if (params.length > 0 || odometerKm != null) {
      await safeDel([`vehicle:${vehicleId}:context`, `customer:${ctx.customerId}:profile`])
    }

    if (odometerKm != null) {
      void maybeRegenerateSchedule(db, vehicleId, Number(odometerKm), ctx.customerId)
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, rego, rego_state, rego_expiry, vin, make, model, series, year,
              colour, body_type, fuel_type, transmission, drive_type,
              engine_code, engine_size_cc, cylinders, tyre_size_front, tyre_size_rear,
              odometer_current, next_service_due_km, next_service_due_date,
              service_interval_km, service_interval_months,
              avatar_image_id, cover_image_id, logbook_token,
              for_sale, asking_price, city, country, description
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!row) return notFound('Vehicle')

    return ok(buildVehicle(row))
  } catch (err) {
    return serverError(err)
  }
}
