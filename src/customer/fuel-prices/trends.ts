import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const VALID_FUEL_TYPES = ['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10','ev_kwh']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  getCustomerContext(event) // auth check only
  const q  = event.queryStringParameters ?? {}

  const stationName = q.stationName?.trim()
  const suburb      = q.suburb?.trim()
  const fuelType    = q.fuelType ?? 'unleaded_95'
  const days        = Math.min(Math.max(Number(q.days ?? 90), 1), 365)

  if (!stationName) return validationError('stationName is required')
  if (!suburb)      return validationError('suburb is required')
  if (!VALID_FUEL_TYPES.includes(fuelType)) return validationError('Invalid fuelType')

  try {
    const [rows] = await db.query<any[]>(
      `SELECT DATE(reported_at) AS date, AVG(price) AS price
       FROM fuel_station_prices
       WHERE LOWER(station_name) = LOWER(?)
         AND LOWER(station_suburb) = LOWER(?)
         AND fuel_type = ?
         AND reported_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(reported_at)
       ORDER BY date ASC`,
      [stationName, suburb, fuelType, days],
    )

    if (rows.length === 0) {
      return ok({
        stationName,
        suburb,
        fuelType,
        days,
        dataPoints: [],
        avgPrice:   null,
        minPrice:   null,
        maxPrice:   null,
      })
    }

    const prices     = rows.map((r: any) => Number(r.price))
    const dataPoints = rows.map((r: any) => ({
      date:  r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      price: Math.round(Number(r.price) * 1000) / 1000,
    }))

    const avgPrice = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 1000) / 1000
    const minPrice = Math.round(Math.min(...prices) * 1000) / 1000
    const maxPrice = Math.round(Math.max(...prices) * 1000) / 1000

    return ok({
      stationName,
      suburb,
      fuelType,
      days,
      dataPoints,
      avgPrice,
      minPrice,
      maxPrice,
    })
  } catch (err) {
    return serverError(err)
  }
}
