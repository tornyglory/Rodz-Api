import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { serverError } from '../../shared/errors'

// GET /public/vehicle-catalog/years
//
// Static year range covering the catalog. No DB read — the range is
// fixed by the seed floor and updated once a year when we roll to the
// next model year. Cached hard.

const YEAR_FLOOR = 1960

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const now  = new Date().getFullYear()
    const ceil = now + 1 // model year for the next calendar year is often sold this year
    const years: number[] = []
    for (let y = ceil; y >= YEAR_FLOOR; y--) years.push(y)

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
      body: JSON.stringify({ years }),
    }
  } catch (err) {
    return serverError(err)
  }
}
