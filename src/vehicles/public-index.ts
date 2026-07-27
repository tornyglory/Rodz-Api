import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { serverError } from '../shared/errors'

const ready = bootstrap()

// Feeds the Cloudflare Pages Function that generates /sitemap.xml.
// Only vehicles opted in for search indexing are returned.
export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT v.logbook_token AS token, v.updated_at AS updated_at
       FROM vehicles v
       WHERE v.is_active = 1
         AND v.logbook_token IS NOT NULL
         AND (
           JSON_EXTRACT(v.public_profile_settings, '$.searchIndex') IS NULL
           OR JSON_EXTRACT(v.public_profile_settings, '$.searchIndex') != CAST('false' AS JSON)
         )`,
    )

    const items = rows.map((r: any) => ({
      token:     r.token,
      updatedAt: r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : new Date(r.updated_at).toISOString(),
    }))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
      body: JSON.stringify({ items }),
    }
  } catch (err) {
    return serverError(err)
  }
}
