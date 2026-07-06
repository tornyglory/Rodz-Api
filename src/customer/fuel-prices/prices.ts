import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'
import { getCustomerContext, isPremium } from '../_helpers'

const ready = bootstrap()

const VALID_FUEL_TYPES = ['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10','ev_kwh']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const q   = event.queryStringParameters ?? {}

  if (!await isPremium(db, ctx.customerId)) return forbidden()

  const suburb   = q.suburb?.trim()
  const state    = q.state?.trim().toUpperCase() ?? null
  const fuelType = q.fuelType ?? 'unleaded_95'
  const radius   = q.radius === 'local' ? 'local' : 'nearby'

  if (!suburb) return validationError('suburb is required')
  if (!VALID_FUEL_TYPES.includes(fuelType)) return validationError('Invalid fuelType')

  try {
    let whereClause: string
    let params: any[]

    if (radius === 'local') {
      whereClause = 'LOWER(station_suburb) = LOWER(?)'
      params = [suburb, fuelType]
    } else {
      // nearby = same suburb first, then expand to same state
      whereClause = state
        ? '(LOWER(station_suburb) = LOWER(?) OR station_state = ?)'
        : 'LOWER(station_suburb) = LOWER(?)'
      params = state ? [suburb, state, fuelType] : [suburb, fuelType]
    }

    const [rows] = await db.query<any[]>(
      `SELECT station_name, station_suburb, station_state, price, price_unit, reported_at
       FROM (
         SELECT station_name, station_suburb, station_state, price, price_unit, reported_at,
           ROW_NUMBER() OVER (PARTITION BY station_name, station_suburb ORDER BY reported_at DESC) AS rn
         FROM fuel_station_prices
         WHERE ${whereClause} AND fuel_type = ?
       ) ranked
       WHERE rn = 1
       ORDER BY price ASC`,
      params,
    )

    const now = Date.now()
    const stations = rows.map((r: any) => {
      const reportedAt = r.reported_at instanceof Date ? r.reported_at : new Date(r.reported_at)
      const ageHours   = Math.round((now - reportedAt.getTime()) / 3_600_000)
      return {
        stationName: r.station_name,
        suburb:      r.station_suburb,
        state:       r.station_state ?? null,
        price:       Number(r.price),
        priceUnit:   r.price_unit,
        reportedAt:  reportedAt.toISOString(),
        ageHours,
        stale:       ageHours > 72,
      }
    })

    return ok({
      suburb,
      fuelType,
      radius,
      asOf:     new Date().toISOString(),
      stations,
    })
  } catch (err) {
    return serverError(err)
  }
}
