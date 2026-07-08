import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import type mysql from 'mysql2/promise'

const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

/**
 * Fire the AI maintenance-schedule generator for a vehicle — but only if there
 * isn't already a schedule for this vehicle. Fire-and-forget, non-blocking,
 * swallows errors so callers can call it as `void`.
 */
export async function invokeRecommendationEngineIfMissing(
  db: mysql.Pool,
  vehicleId: number,
  customerId: number,
): Promise<void> {
  const arn = process.env.AI_RECOMMENDATION_FN_ARN
  if (!arn) return

  try {
    const [[row]] = await db.query<any[]>(
      'SELECT 1 AS present FROM ai_recommendations WHERE vehicle_id = ? LIMIT 1',
      [vehicleId],
    )
    if (row) return

    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId, customerId })),
    }))
  } catch (err) {
    console.error('invokeRecommendationEngineIfMissing failed:', err)
  }
}

const ODOMETER_REGEN_THRESHOLD_KM = 10_000

/**
 * Fire the AI maintenance-schedule generator if the odometer has moved more
 * than ODOMETER_REGEN_THRESHOLD_KM (10,000 km) since the schedule was last
 * generated. Also fires if there's no schedule at all. Fire-and-forget.
 *
 * If `customerId` is not supplied, we look up the current owner from
 * vehicle_owners.
 */
export async function maybeRegenerateSchedule(
  db: mysql.Pool,
  vehicleId: number,
  newOdometerKm: number,
  customerId?: number,
): Promise<void> {
  const arn = process.env.AI_RECOMMENDATION_FN_ARN
  if (!arn) return
  if (!newOdometerKm || newOdometerKm < 0) return

  try {
    const [[row]] = await db.query<any[]>(
      'SELECT MAX(triggered_at_odometer) AS last_km FROM ai_recommendations WHERE vehicle_id = ?',
      [vehicleId],
    )
    const lastKm = row?.last_km != null ? Number(row.last_km) : null

    if (lastKm != null && Math.abs(newOdometerKm - lastKm) < ODOMETER_REGEN_THRESHOLD_KM) return

    let resolvedCustomerId = customerId
    if (resolvedCustomerId == null) {
      const [[owner]] = await db.query<any[]>(
        'SELECT customer_id FROM vehicle_owners WHERE vehicle_id = ? AND is_current = 1 LIMIT 1',
        [vehicleId],
      )
      if (!owner?.customer_id) return
      resolvedCustomerId = Number(owner.customer_id)
    }

    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId, customerId: resolvedCustomerId })),
    }))
  } catch (err) {
    console.error('maybeRegenerateSchedule failed:', err)
  }
}

export async function invokeVehicleProfileEngine(vehicleId: number): Promise<void> {
  const arn = process.env.VEHICLE_PROFILE_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ vehicleId })),
    }))
  } catch (err) {
    console.error('invokeVehicleProfileEngine failed:', err)
  }
}
