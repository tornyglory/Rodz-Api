import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, serverError } from '../shared/errors'
import { imageUrls } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    // Look up vehicle by token — check without is_active to distinguish 404 vs 410
    const [[vehicle]] = await db.query<any[]>(
      `SELECT id, rego, year, make, model, series, colour,
              fuel_type, transmission, engine_size_cc, vin,
              odometer_current, avatar_image_id, cover_image_id, is_active,
              for_sale, asking_price, city, country,
              contact_name, contact_phone, contact_email
       FROM vehicles
       WHERE logbook_token = ?
       LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    // Gallery images
    const [galleryRows] = await db.query<any[]>(
      `SELECT id, image_id, sort_order
       FROM vehicle_gallery_images
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC`,
      [vehicle.id],
    )

    const engineSize = vehicle.engine_size_cc
      ? `${(Number(vehicle.engine_size_cc) / 1000).toFixed(1)}L`
      : null

    return ok({
      rego:            vehicle.rego,
      year:            vehicle.year,
      make:            vehicle.make,
      model:           vehicle.model,
      series:          vehicle.series          ?? null,
      colour:          vehicle.colour          ?? null,
      fuelType:        vehicle.fuel_type       ?? null,
      transmission:    vehicle.transmission    ?? null,
      engineSize,
      vin:             vehicle.vin             ?? null,
      odometerCurrent: vehicle.odometer_current != null ? Number(vehicle.odometer_current) : null,
      avatarUrl:       vehicle.avatar_image_id ? imageUrls(vehicle.avatar_image_id).public     : null,
      coverUrl:        vehicle.cover_image_id  ? imageUrls(vehicle.cover_image_id).public      : null,
      forSale:         !!vehicle.for_sale,
      askingPrice:     vehicle.asking_price  != null ? Number(vehicle.asking_price)  : null,
      city:            vehicle.city          ?? null,
      country:         vehicle.country       ?? null,
      contactName:     vehicle.contact_name  ?? null,
      contactPhone:    vehicle.contact_phone ?? null,
      contactEmail:    vehicle.contact_email ?? null,
      images: galleryRows.map((r: any) => ({
        id:           r.id,
        url:          imageUrls(r.image_id).public,
        thumbnailUrl: imageUrls(r.image_id).thumbnail,
        sortOrder:    r.sort_order,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
