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
    // Look up vehicle by token — no is_active filter so we can distinguish 404 vs 410
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.year, v.make, v.model, v.series, v.colour,
              v.fuel_type, v.transmission, v.engine_size_cc, v.vin,
              v.odometer_current, v.avatar_image_id, v.cover_image_id, v.is_active,
              v.for_sale, v.asking_price, v.city, v.country
       FROM vehicles v
       WHERE v.logbook_token = ?
       LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    // Check if sold within last 90 days (most recent released_date on the vehicle)
    const [[recentSale]] = await db.query<any[]>(
      `SELECT released_date FROM vehicle_owners
       WHERE vehicle_id = ? AND is_current = 0 AND released_date IS NOT NULL
       ORDER BY released_date DESC LIMIT 1`,
      [vehicle.id],
    )
    const soldAt = recentSale?.released_date
      ? (recentSale.released_date instanceof Date
          ? recentSale.released_date.toISOString().slice(0, 10)
          : String(recentSale.released_date).slice(0, 10))
      : null
    const sold = soldAt
      ? (Date.now() - new Date(soldAt).getTime()) < 90 * 24 * 60 * 60 * 1000
      : false

    // Contact details come from the current owner — auto-updates on ownership transfer
    const [[owner]] = await db.query<any[]>(
      `SELECT CONCAT(c.first_name, ' ', c.last_name) AS contact_name,
              c.mobile AS contact_phone,
              c.email  AS contact_email
       FROM vehicle_owners vo
       JOIN customers c ON c.id = vo.customer_id
       WHERE vo.vehicle_id = ? AND vo.is_current = 1
       LIMIT 1`,
      [vehicle.id],
    )

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
      avatarUrl:       vehicle.avatar_image_id ? imageUrls(vehicle.avatar_image_id).public : null,
      coverUrl:        vehicle.cover_image_id  ? imageUrls(vehicle.cover_image_id).public  : null,
      sold,
      soldAt,
      forSale:         !!vehicle.for_sale,
      askingPrice:     vehicle.asking_price != null ? Number(vehicle.asking_price) : null,
      city:            vehicle.city    ?? null,
      country:         vehicle.country ?? null,
      contactName:     owner?.contact_name  ?? null,
      contactPhone:    owner?.contact_phone ?? null,
      contactEmail:    owner?.contact_email ?? null,
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
