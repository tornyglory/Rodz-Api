import crypto from 'crypto'
import type mysql from 'mysql2/promise'
import { imageUrls } from '../../shared/cloudflare'
import { parsePublicProfileSettings } from '../../shared/publicProfileSettings'

// Normalise a DATE column to ISO YYYY-MM-DD. mysql2 hands back Date objects
// for DATE columns; JSON.stringify on those produces a full datetime string
// with a timezone shift (UTC midnight → date change), which is why we
// slice from an ISO representation rather than relying on serialization.
function toIsoDate(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// Result of loading a vehicle for a full staff-side profile response.
// `state` distinguishes between "row missing" (404), "soft-deleted" (410),
// and "usable" (200). Callers switch on it.
export type VehicleLoad =
  | { state: 'missing' }
  | { state: 'gone' }
  | { state: 'ok'; storeId: number | null; payload: Record<string, unknown> }

export async function loadVehicleForResponse(
  db: mysql.Pool,
  customerId: number | string,
  vehicleId: number | string,
): Promise<VehicleLoad> {
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
       v.avatar_image_id, v.avatar_illustration_image_id, v.cover_image_id, v.logbook_token,
       v.for_sale, v.asking_price, v.city, v.country,
       v.description, v.public_profile_settings, v.is_active,
       c.id AS customer_id, c.store_id, c.description AS owner_description
     FROM vehicles v
     JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
     JOIN customers c       ON c.id = vo.customer_id
     WHERE v.id = ? AND vo.customer_id = ? AND c.is_active = 1
     LIMIT 1`,
    [vehicleId, customerId],
  )
  if (!row) return { state: 'missing' }
  if (!row.is_active) return { state: 'gone' }

  let logbookToken: string | null = row.logbook_token ?? null
  if (!logbookToken) {
    logbookToken = crypto.randomBytes(32).toString('hex')
    await db.query('UPDATE vehicles SET logbook_token = ? WHERE id = ?', [logbookToken, row.id])
  }

  const [galleryRows] = await db.query<any[]>(
    `SELECT id, image_id, sort_order
     FROM vehicle_gallery_images
     WHERE vehicle_id = ? AND deleted_at IS NULL
     ORDER BY sort_order ASC, id ASC`,
    [row.id],
  )

  const payload = {
    id:                    row.id,
    rego:                  row.rego,
    regoState:             row.rego_state              ?? null,
    regoExpiry:            toIsoDate(row.rego_expiry),
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
    nextServiceDueDate:    toIsoDate(row.next_service_due_date),
    fleetUnitNumber:       row.fleet_unit_number       ?? null,
    internalNotes:         row.internal_notes          ?? null,
    description:           row.description             ?? null,
    avatarImageId:              row.avatar_image_id              ?? null,
    avatarIllustrationImageId:  row.avatar_illustration_image_id ?? null,
    coverImageId:               row.cover_image_id               ?? null,
    avatarUrl:                  row.avatar_image_id              ? imageUrls(row.avatar_image_id).thumbnail : null,
    avatarIllustrationUrl:      row.avatar_illustration_image_id ? imageUrls(row.avatar_illustration_image_id).thumbnail : null,
    coverUrl:                   row.cover_image_id               ? imageUrls(row.cover_image_id).public      : null,
    logbookToken,
    forSale:               !!row.for_sale,
    askingPrice:           row.asking_price != null ? Number(row.asking_price) : null,
    city:                  row.city                    ?? null,
    country:               row.country                 ?? null,
    publicProfileSettings: parsePublicProfileSettings(row.public_profile_settings),
    ownerDescription:      row.owner_description       ?? null,
    gallery: galleryRows.map((g: any) => ({
      id:           g.id,
      url:          imageUrls(g.image_id).public,
      thumbnailUrl: imageUrls(g.image_id).thumbnail,
      sortOrder:    g.sort_order,
    })),
  }

  return { state: 'ok', storeId: row.store_id ?? null, payload }
}
