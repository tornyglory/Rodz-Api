import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, forbidden, serverError } from '../../shared/errors'
import { getCustomerContext, buildVehicle } from '../_helpers'
import { imageUrls } from '../../shared/cloudflare'
import { parsePublicProfileSettings } from '../../shared/publicProfileSettings'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db         = getPool()
  const ctx        = getCustomerContext(event)
  const vehicleId  = Number(event.pathParameters?.id)

  try {
    // Verify ownership
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[row]] = await db.query<any[]>(
      `SELECT id, rego, rego_state, rego_expiry, vin, make, model, series, year,
              colour, body_type, fuel_type, transmission, drive_type,
              engine_code, engine_size_cc, cylinders, tyre_size_front, tyre_size_rear,
              odometer_current, next_service_due_km, next_service_due_date,
              service_interval_km, service_interval_months,
              avatar_image_id, cover_image_id, logbook_token,
              for_sale, asking_price, city, country, public_profile_settings
       FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
      [vehicleId],
    )
    if (!row) return notFound('Vehicle')

    const [galleryRows] = await db.query<any[]>(
      `SELECT id, image_id, sort_order FROM vehicle_gallery_images
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC`,
      [vehicleId],
    )

    return ok({
      ...buildVehicle(row),
      publicProfileSettings: parsePublicProfileSettings(row.public_profile_settings),
      gallery: galleryRows.map((g: any) => ({
        id:           g.id,
        url:          imageUrls(g.image_id).public,
        thumbnailUrl: imageUrls(g.image_id).thumbnail,
        sortOrder:    g.sort_order,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
