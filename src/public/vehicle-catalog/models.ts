import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/vehicle-catalog/models?year=YYYY&make=slug
//
// Models for the given make in the given year. Sorted popular-first,
// then alphabetical. 404 if the make slug doesn't exist at all in the
// catalog; empty array is a valid result (make exists but no models
// covered that year).

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const yearStr  = event.queryStringParameters?.year
  const makeSlug = (event.queryStringParameters?.make ?? '').trim().toLowerCase()
  const year = Number(yearStr)

  if (!yearStr || !Number.isInteger(year) || year < 1900 || year > 2100) {
    return badRequest('year query param is required and must be a valid year.')
  }
  if (!makeSlug) {
    return badRequest('make query param is required.')
  }

  try {
    const [[mk]] = await db.query<any[]>(
      'SELECT id, slug, name FROM vehicle_makes WHERE slug = ? LIMIT 1',
      [makeSlug],
    )
    if (!mk) return notFound('Make')

    const [rows] = await db.query<any[]>(
      `SELECT slug, name, popular, year_start, year_end
       FROM vehicle_models
       WHERE make_id = ? AND year_start <= ? AND year_end >= ?
       ORDER BY popular DESC, name ASC`,
      [mk.id, year, year],
    )

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
      body: JSON.stringify({
        year,
        make: mk.slug,
        models: rows.map((r: any) => ({
          slug:    r.slug,
          name:    r.name,
          popular: !!r.popular,
        })),
      }),
    }
  } catch (err) {
    return serverError(err)
  }
}
