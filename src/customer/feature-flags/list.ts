import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /c/feature-flags — customer-facing map of flag_key → enabled.
// No description, no audit fields. Missing keys → frontend defaults to
// true (fail-open — so a not-yet-seeded flag can't nuke the app).
//
// Response is `Cache-Control: no-store` — the server is authoritative on
// every fetch. A stale toggle can mean the customer keeps seeing a
// feature we just disabled for an incident.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      'SELECT flag_key, enabled FROM feature_flags',
    )
    const flags: Record<string, boolean> = {}
    for (const r of rows as any[]) {
      flags[r.flag_key] = Number(r.enabled) === 1
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ flags }),
    }
  } catch (err) {
    return serverError(err)
  }
}
