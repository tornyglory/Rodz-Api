import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

async function triggerProfileGeneration(vehicleId: number): Promise<void> {
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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.make, v.model, v.year
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicle) return notFound('Vehicle')

    if (ctx.role !== 'super_admin') {
      const [[customer]] = await db.query<any[]>(
        'SELECT store_id FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customer?.store_id !== ctx.storeId) return notFound('Vehicle')
    }

    const [[row]] = await db.query<any[]>(
      `SELECT overview, engine_specs, tyre_specs, service_notes, known_issues, common_repairs, generated_at
       FROM vehicle_model_profiles
       WHERE make = ? AND model = ? AND year = ?
       LIMIT 1`,
      [vehicle.make, vehicle.model, vehicle.year],
    )

    if (!row) {
      void triggerProfileGeneration(Number(vehicleId))
      return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'generating' }),
      }
    }

    return ok({
      status:       'ready',
      make:         vehicle.make,
      model:        vehicle.model,
      year:         vehicle.year,
      generatedAt:  new Date(row.generated_at).toISOString(),
      overview:     row.overview,
      engineSpecs:  row.engine_specs,
      tyreSpecs:    row.tyre_specs,
      serviceNotes: row.service_notes,
      knownIssues:  row.known_issues,
      commonRepairs: row.common_repairs,
    })
  } catch (err) {
    return serverError(err)
  }
}
