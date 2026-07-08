import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, serverError } from '../../shared/errors'
import { imageUrls } from '../../shared/cloudflare'
import { parsePublicProfileSettings } from '../../shared/publicProfileSettings'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT
         v.id, v.rego, v.rego_state, v.rego_expiry, v.vin,
         v.make, v.model, v.series, v.year, v.colour,
         v.body_type, v.fuel_type, v.transmission, v.drive_type,
         v.engine_code, v.engine_size_cc, v.cylinders,
         v.tyre_size_front, v.tyre_size_rear, v.spare_tyre_size,
         v.odometer_unit, v.odometer_current, v.odometer_at_purchase,
         v.service_interval_km, v.service_interval_months,
         v.next_service_due_km, v.next_service_due_date,
         v.fleet_unit_number, v.internal_notes,
         v.avatar_image_id, v.cover_image_id, v.logbook_token,
         v.for_sale, v.asking_price, v.city, v.country,
         v.public_profile_settings
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       JOIN customers c       ON c.id = vo.customer_id
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1 AND c.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!row) return notFound('Vehicle')

    if (ctx.role !== 'super_admin') {
      const [[customer]] = await db.query<any[]>(
        'SELECT store_id FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customer?.store_id !== ctx.storeId) return notFound('Vehicle')
    }

    const [galleryRows] = await db.query<any[]>(
      `SELECT id, image_id, sort_order
       FROM vehicle_gallery_images
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC`,
      [vehicleId],
    )

    return ok({
      vehicle: {
        id:                    row.id,
        rego:                  row.rego,
        regoState:             row.rego_state              ?? null,
        regoExpiry:            row.rego_expiry             ? String(row.rego_expiry).slice(0, 10) : null,
        vin:                   row.vin                     ?? null,
        make:                  row.make,
        model:                 row.model,
        series:                row.series                  ?? null,
        year:                  row.year,
        colour:                row.colour                  ?? null,
        bodyType:              row.body_type               ?? null,
        fuelType:              row.fuel_type,
        transmission:          row.transmission,
        driveType:             row.drive_type              ?? null,
        engineCode:            row.engine_code             ?? null,
        engineSizeCC:          row.engine_size_cc          ?? null,
        cylinders:             row.cylinders               ?? null,
        tyreSizeFront:         row.tyre_size_front         ?? null,
        tyreSizeRear:          row.tyre_size_rear          ?? null,
        spareTyreSize:         row.spare_tyre_size         ?? null,
        odometerUnit:          row.odometer_unit,
        odometerCurrent:       row.odometer_current        ?? null,
        odometerAtPurchase:    row.odometer_at_purchase    ?? null,
        serviceIntervalKm:     row.service_interval_km     ?? null,
        serviceIntervalMonths: row.service_interval_months ?? null,
        nextServiceDueKm:      row.next_service_due_km     ?? null,
        nextServiceDueDate:    row.next_service_due_date   ? String(row.next_service_due_date).slice(0, 10) : null,
        fleetUnitNumber:       row.fleet_unit_number       ?? null,
        internalNotes:         row.internal_notes          ?? null,
        avatarImageId:         row.avatar_image_id         ?? null,
        coverImageId:          row.cover_image_id          ?? null,
        avatarUrl:             row.avatar_image_id ? imageUrls(row.avatar_image_id).thumbnail : null,
        coverUrl:              row.cover_image_id  ? imageUrls(row.cover_image_id).public      : null,
        logbookToken:          row.logbook_token           ?? null,
        forSale:               !!row.for_sale,
        askingPrice:           row.asking_price != null ? Number(row.asking_price) : null,
        city:                  row.city                    ?? null,
        country:               row.country                 ?? null,
        publicProfileSettings: parsePublicProfileSettings(row.public_profile_settings),
        gallery: galleryRows.map((g: any) => ({
          id:           g.id,
          url:          imageUrls(g.image_id).public,
          thumbnailUrl: imageUrls(g.image_id).thumbnail,
          sortOrder:    g.sort_order,
        })),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
