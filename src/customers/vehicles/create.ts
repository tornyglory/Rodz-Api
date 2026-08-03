import crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { invokeRecommendationEngineIfMissing, invokeVehicleProfileEngine } from '../../shared/aiEngines'
import { loadVehicleForResponse } from './_helpers'

const ready = bootstrap()

const conflict = (code: string, message: string) => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: { code, message } }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const customerId = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [customerId],
    )
    if (!customer) return notFound('Customer')

    const { rego, year, make, model, odometerCurrent, avgKmPerWeek } = JSON.parse(event.body ?? '{}')
    if (!rego?.trim())  return validationError('rego is required.')
    if (!year)          return validationError('year is required.')
    if (!make?.trim())  return validationError('make is required.')
    if (!model?.trim()) return validationError('model is required.')

    // Optional at create — staff can fill later. Anchors the maintenance
    // pipeline: odometer is the AI schedule's starting point + weekly-bump
    // anchor; avg_km_per_week overrides the 240 km/week default.
    let odometerCurrentVal: number | null = null
    if (odometerCurrent != null && odometerCurrent !== '') {
      const n = Number(odometerCurrent)
      if (!Number.isFinite(n) || n < 0 || n > 2_000_000) {
        return validationError('odometerCurrent must be a number between 0 and 2,000,000.')
      }
      odometerCurrentVal = Math.floor(n)
    }
    let avgKmPerWeekVal: number | null = null
    if (avgKmPerWeek != null && avgKmPerWeek !== '') {
      const n = Number(avgKmPerWeek)
      if (!Number.isFinite(n) || n < 0 || n > 5000) {
        return validationError('avgKmPerWeek must be a number between 0 and 5,000.')
      }
      avgKmPerWeekVal = Math.floor(n)
    }

    const regoNorm = rego.trim().toUpperCase()
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE rego = ? LIMIT 1',
      [regoNorm],
    )
    if (existing) return conflict('DUPLICATE_REGO', `Rego ${regoNorm} already exists.`)

    // Generate the logbook token at create time so the setup wizard can
    // immediately hit /logbook/{token}/profile for the AI profile step.
    // Previously created lazily on first read via loadVehicleForResponse
    // — but the wizard needs it back inside the same round-trip.
    const logbookToken = crypto.randomBytes(32).toString('hex')

    const [vResult] = await db.query<any>(
      `INSERT INTO vehicles
         (rego, make, model, year, fuel_type, transmission,
          odometer_current, odometer_recorded_at, avg_km_per_week, logbook_token)
       VALUES (?, ?, ?, ?, 'petrol', 'automatic', ?, ${odometerCurrentVal != null ? 'NOW()' : 'NULL'}, ?, ?)`,
      [regoNorm, make.trim(), model.trim(), Number(year), odometerCurrentVal, avgKmPerWeekVal, logbookToken],
    )

    await db.query(
      `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current)
       VALUES (?, ?, CURDATE(), 1)`,
      [vResult.insertId, customerId],
    )

    await invokeVehicleProfileEngine(vResult.insertId)
    await invokeRecommendationEngineIfMissing(db, vResult.insertId, Number(customerId))

    // Return the full shape used by every other endpoint (staff GET,
    // customer GET, etc.) so the wizard doesn't need a follow-up fetch
    // to see fields like `logbookToken`, `avatarUrl`, `publicProfileSettings`.
    const loaded = await loadVehicleForResponse(db, customerId!, vResult.insertId)
    if (loaded.state !== 'ok') {
      // Should be unreachable — we just inserted the row + owner link.
      return serverError(new Error(`Vehicle ${vResult.insertId} not readable after create.`))
    }
    return created({ vehicle: loaded.payload })
  } catch (err) {
    return serverError(err)
  }
}
