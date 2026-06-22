import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.make, v.model, v.year
       FROM vehicles v
       WHERE v.logbook_token = ? AND v.is_active = 1
       LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')

    const [[row]] = await db.query<any[]>(
      `SELECT overview, engine_specs, tyre_specs, service_notes, known_issues, common_repairs, generated_at
       FROM vehicle_model_profiles
       WHERE make = ? AND model = ? AND year = ?
       LIMIT 1`,
      [vehicle.make, vehicle.model, vehicle.year],
    )

    if (!row) return notFound('Profile')

    return ok({
      status:        'ready',
      make:          vehicle.make,
      model:         vehicle.model,
      year:          vehicle.year,
      generatedAt:   new Date(row.generated_at).toISOString(),
      overview:      row.overview,
      engineSpecs:   row.engine_specs,
      tyreSpecs:     row.tyre_specs,
      serviceNotes:  row.service_notes,
      knownIssues:   row.known_issues,
      commonRepairs: row.common_repairs,
    })
  } catch (err) {
    return serverError(err)
  }
}
