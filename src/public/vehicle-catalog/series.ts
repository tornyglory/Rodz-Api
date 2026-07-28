import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/vehicle-catalog/series?year=YYYY&make=slug&model=slug
//
// Series (generations) for the given model in the given year. Empty
// array is a valid result — modern cars like Corolla / Yaris have no
// meaningful series distinctions, and the guest picker should skip the
// series step when this is empty. 404 if the make or model slug
// doesn't resolve.

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const yearStr   = event.queryStringParameters?.year
  const makeSlug  = (event.queryStringParameters?.make  ?? '').trim().toLowerCase()
  const modelSlug = (event.queryStringParameters?.model ?? '').trim().toLowerCase()
  const year = Number(yearStr)

  if (!yearStr || !Number.isInteger(year) || year < 1900 || year > 2100) {
    return badRequest('year query param is required and must be a valid year.')
  }
  if (!makeSlug)  return badRequest('make query param is required.')
  if (!modelSlug) return badRequest('model query param is required.')

  try {
    const [[mo]] = await db.query<any[]>(
      `SELECT mo.id, mo.slug AS model_slug, mk.slug AS make_slug
       FROM vehicle_models mo
       JOIN vehicle_makes mk ON mk.id = mo.make_id
       WHERE mk.slug = ? AND mo.slug = ?
       LIMIT 1`,
      [makeSlug, modelSlug],
    )
    if (!mo) return notFound('Model')

    const [rows] = await db.query<any[]>(
      `SELECT slug, name, year_start, year_end, popular
       FROM vehicle_model_series
       WHERE model_id = ? AND year_start <= ? AND year_end >= ?
       ORDER BY year_start ASC, name ASC`,
      [mo.id, year, year],
    )

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
      body: JSON.stringify({
        year,
        make:  mo.make_slug,
        model: mo.model_slug,
        series: rows.map((r: any) => ({
          slug:       r.slug,
          name:       r.name,
          yearStart:  r.year_start,
          yearEnd:    r.year_end,
          popular:    !!r.popular,
        })),
      }),
    }
  } catch (err) {
    return serverError(err)
  }
}
