import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/service-types
//
// Public read of bookable services for the guest booking flow's
// service picker. Filters to is_active=1 AND is_bookable=1 so
// workshop-internal services (e.g. "wheel alignment as part of a
// bigger job") stay out of the picker.
//
// Sort: popular first (top 5 hand-picked), then alphabetical.
// slug is the URL-safe identifier used by marketing landing pages
// to pre-select via ?service=... query param.

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id, slug, name, description, popular
       FROM service_types
       WHERE is_active = 1 AND is_bookable = 1
       ORDER BY popular DESC, name ASC`,
    )

    const serviceTypes = rows.map((r: any) => ({
      id:          Number(r.id),
      slug:        r.slug ?? null,
      name:        r.name,
      description: r.description ?? null,
      popular:     !!r.popular,
    }))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
      body: JSON.stringify({ serviceTypes }),
    }
  } catch (err) {
    return serverError(err)
  }
}
