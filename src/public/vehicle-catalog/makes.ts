import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { badRequest, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/vehicle-catalog/makes?year=YYYY
//
// Makes with at least one model available in the given year. Sorted
// popular-first, then alphabetical. Feeds the make picker on the
// guest booking flow.

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  const yearStr = event.queryStringParameters?.year
  const year = Number(yearStr)
  if (!yearStr || !Number.isInteger(year) || year < 1900 || year > 2100) {
    return badRequest('year query param is required and must be a valid year.')
  }

  try {
    const [rows] = await db.query<any[]>(
      `SELECT DISTINCT mk.slug, mk.name, mk.popular
       FROM vehicle_makes mk
       JOIN vehicle_models mo ON mo.make_id = mk.id
       WHERE mo.year_start <= ? AND mo.year_end >= ?
       ORDER BY mk.popular DESC, mk.name ASC`,
      [year, year],
    )

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
      body: JSON.stringify({
        year,
        makes: rows.map((r: any) => ({
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
