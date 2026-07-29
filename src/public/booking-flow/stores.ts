import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /public/stores
//
// Public read of active stores for the guest booking flow's store
// picker. No auth — this is the anonymous funnel path. Distinct from
// the legacy /public/stores endpoint on the shared HttpApi which is
// x-api-key gated and bundles business_hours inline.
//
// lat/lng/mapUrl aren't stored yet — returning null; add geocoding
// columns + backfill later if the frontend actually needs them.

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id, name, address_line1, suburb, state, postcode, phone
       FROM stores
       WHERE is_active = 1
       ORDER BY id ASC`,
    )

    // Concatenate address parts only when address_line1 doesn't already
    // contain the suburb — some seed rows have the full address in
    // line1, others just the street. Detect by lowercase-substring
    // check to avoid emitting duplicated "…, Somerville VIC 3912,
    // Somerville VIC 3912" strings.
    const buildAddress = (line1: string, suburb: string, state: string, postcode: string): string => {
      const line1Trim = (line1 ?? '').trim()
      const tail = [suburb, state, postcode].filter(Boolean).join(' ').trim()
      if (!tail) return line1Trim
      if (line1Trim.toLowerCase().includes(suburb?.toLowerCase() ?? '__nope__')) return line1Trim
      return line1Trim ? `${line1Trim}, ${tail}` : tail
    }

    const stores = rows.map((r: any) => ({
      id:      Number(r.id),
      name:    r.name,
      suburb:  r.suburb || null,
      state:   r.state  || null,
      address: buildAddress(r.address_line1, r.suburb, r.state, r.postcode),
      phone:   r.phone  || null,
      lat:     null,
      lng:     null,
      mapUrl:  null,
    }))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
      body: JSON.stringify({ stores }),
    }
  } catch (err) {
    return serverError(err)
  }
}
