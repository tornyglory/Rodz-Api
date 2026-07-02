import * as crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { created, validationError, serverError } from '../../shared/errors'
import { getCustomerContext, parseVehicle, buildVehicle } from '../_helpers'

const ready       = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

const VALID_STATES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])

async function invokeVehicleProfileEngine(vehicleId: number): Promise<void> {
  const arn = process.env.VEHICLE_PROFILE_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId })),
    }))
  } catch (err) {
    console.error('Failed to invoke VehicleProfileEngine:', err)
  }
}

async function invokeRecommendationEngine(vehicleId: number, customerId: number): Promise<void> {
  const arn = process.env.AI_RECOMMENDATION_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId, customerId })),
    }))
  } catch (err) {
    console.error('Failed to invoke AIRecommendationEngine:', err)
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { rego, regoState, vehicle } = body

    if (!rego || !regoState || !vehicle) {
      return validationError('rego, regoState and vehicle description are required.')
    }

    const regoStr  = String(rego).trim().toUpperCase()
    const stateStr = String(regoState).trim().toUpperCase()

    if (!VALID_STATES.has(stateStr)) {
      return validationError('Invalid regoState.')
    }

    const parsed = await parseVehicle(String(vehicle))
    if ('error' in parsed) return validationError(parsed.error)

    // Check if vehicle already exists for this rego
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE rego = ? AND is_active = 1 LIMIT 1',
      [regoStr],
    )

    let vehicleId: number

    if (existing) {
      vehicleId = existing.id
    } else {
      const logbookToken = crypto.randomBytes(32).toString('hex')
      const [ins] = await db.query<any>(
        `INSERT INTO vehicles
           (rego, rego_state, make, model, series, year, fuel_type, transmission,
            body_type, engine_code, engine_size_cc, cylinders, drive_type,
            colour, tyre_size_front, tyre_size_rear, spare_tyre_size,
            service_interval_km, service_interval_months, logbook_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          regoStr, stateStr, parsed.make, parsed.model, parsed.series, parsed.year,
          parsed.fuelType ?? 'petrol', parsed.transmission ?? 'automatic', parsed.bodyType ?? null,
          parsed.engineCode ?? null, parsed.engineSizeCC ?? null, parsed.cylinders ?? null,
          parsed.driveType ?? null, parsed.colour ?? null, parsed.tyreSizeFront ?? null,
          parsed.tyreSizeRear ?? null, parsed.spareTyreSize ?? null,
          parsed.serviceIntervalKm ?? null, parsed.serviceIntervalMonths ?? null,
          logbookToken,
        ],
      )
      vehicleId = ins.insertId
    }

    // Link to customer if not already linked
    const [[ownerLink]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )

    if (!ownerLink) {
      await db.query(
        `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current, created_at)
         VALUES (?, ?, CURDATE(), 1, NOW())`,
        [vehicleId, ctx.customerId],
      )
      void invokeVehicleProfileEngine(vehicleId)
      void invokeRecommendationEngine(vehicleId, ctx.customerId)
    }

    const [[vehicleRow]] = await db.query<any[]>(
      `SELECT id, rego, rego_state, rego_expiry, vin, make, model, series, year,
              colour, body_type, fuel_type, transmission, drive_type,
              engine_code, engine_size_cc, cylinders, tyre_size_front, tyre_size_rear,
              odometer_current, next_service_due_km, next_service_due_date,
              service_interval_km, service_interval_months,
              avatar_image_id, cover_image_id, logbook_token
       FROM vehicles WHERE id = ? LIMIT 1`,
      [vehicleId],
    )

    return created(buildVehicle(vehicleRow))
  } catch (err) {
    return serverError(err)
  }
}
