import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { getCustomerContext } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  getCustomerContext(event)
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id, name, address_line1, suburb, state, postcode, phone, google_maps_url
       FROM stores WHERE is_active = 1 ORDER BY name`,
    )

    return ok({
      stores: rows.map((r: any) => ({
        id:          r.id,
        name:        r.name,
        address:     r.address_line1,
        suburb:      r.suburb,
        state:       r.state,
        postcode:    r.postcode,
        phone:       r.phone      ?? null,
        mapsUrl:     r.google_maps_url ?? null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
