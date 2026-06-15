import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

const VALID_BODY_TYPE    = new Set(['sedan','hatch','wagon','ute','van','suv','coupe','convertible','truck','other'])
const VALID_FUEL_TYPE    = new Set(['petrol','diesel','hybrid','electric','lpg','other'])
const VALID_TRANSMISSION = new Set(['manual','automatic','cvt','dct','other'])
const VALID_DRIVE_TYPE   = new Set(['fwd','rwd','awd','4wd'])
const VALID_REGO_STATE   = new Set(['VIC','NSW','QLD','SA','WA','TAS','NT','ACT'])
const VALID_ODOM_UNIT    = new Set(['km','mi'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[owner]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, customerId],
    )
    if (!owner) return notFound('Vehicle')

    const body    = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const updates: [string, unknown][] = []

    // ── Identity ───────────────────────────────────────────────────────────
    if (body.rego != null)
      updates.push(['rego', String(body.rego).trim().toUpperCase()])

    if (body.regoState != null) {
      const v = String(body.regoState).toUpperCase()
      if (!VALID_REGO_STATE.has(v)) return validationError('Invalid regoState.')
      updates.push(['rego_state', v])
    }

    if (body.regoExpiry != null)
      updates.push(['rego_expiry', String(body.regoExpiry)])

    if (body.vin != null)
      updates.push(['vin', String(body.vin).trim().toUpperCase() || null])

    // ── Specs ──────────────────────────────────────────────────────────────
    if (body.make  != null) updates.push(['make',  String(body.make).trim()])
    if (body.model != null) updates.push(['model', String(body.model).trim()])
    if (body.series != null) updates.push(['series', String(body.series).trim() || null])
    if (body.year  != null) updates.push(['year',  Number(body.year)])
    if (body.colour != null) updates.push(['colour', String(body.colour).trim() || null])

    if (body.bodyType != null) {
      const v = String(body.bodyType)
      if (!VALID_BODY_TYPE.has(v)) return validationError('Invalid bodyType.')
      updates.push(['body_type', v])
    }

    if (body.fuelType != null) {
      const v = String(body.fuelType)
      if (!VALID_FUEL_TYPE.has(v)) return validationError('Invalid fuelType.')
      updates.push(['fuel_type', v])
    }

    if (body.transmission != null) {
      const v = String(body.transmission)
      if (!VALID_TRANSMISSION.has(v)) return validationError('Invalid transmission.')
      updates.push(['transmission', v])
    }

    if (body.driveType != null) {
      const v = String(body.driveType)
      if (!VALID_DRIVE_TYPE.has(v)) return validationError('Invalid driveType.')
      updates.push(['drive_type', v])
    }

    if (body.engineCode    != null) updates.push(['engine_code',    String(body.engineCode).trim() || null])
    if (body.engineSizeCC  != null) updates.push(['engine_size_cc', Number(body.engineSizeCC) || null])
    if (body.cylinders     != null) updates.push(['cylinders',      Number(body.cylinders) || null])

    // ── Tyres ──────────────────────────────────────────────────────────────
    if (body.tyreSizeFront != null) updates.push(['tyre_size_front', String(body.tyreSizeFront).trim() || null])
    if (body.tyreSizeRear  != null) updates.push(['tyre_size_rear',  String(body.tyreSizeRear).trim()  || null])
    if (body.spareTyreSize != null) updates.push(['spare_tyre_size', String(body.spareTyreSize).trim() || null])

    // ── Odometer ───────────────────────────────────────────────────────────
    if (body.odometerUnit != null) {
      const v = String(body.odometerUnit)
      if (!VALID_ODOM_UNIT.has(v)) return validationError('Invalid odometerUnit.')
      updates.push(['odometer_unit', v])
    }

    if (body.odometerCurrent != null) {
      updates.push(['odometer_current',     Number(body.odometerCurrent)])
      updates.push(['odometer_recorded_at', new Date().toISOString().slice(0, 10)])
    }
    if (body.odometerAtPurchase != null) updates.push(['odometer_at_purchase', Number(body.odometerAtPurchase)])

    // ── Service intervals ──────────────────────────────────────────────────
    if (body.serviceIntervalKm     != null) updates.push(['service_interval_km',     Number(body.serviceIntervalKm)])
    if (body.serviceIntervalMonths != null) updates.push(['service_interval_months', Number(body.serviceIntervalMonths)])
    if (body.nextServiceDueKm      != null) updates.push(['next_service_due_km',     Number(body.nextServiceDueKm)])
    if (body.nextServiceDueDate    != null) updates.push(['next_service_due_date',   String(body.nextServiceDueDate)])

    // ── Other ──────────────────────────────────────────────────────────────
    if (body.fleetUnitNumber != null) updates.push(['fleet_unit_number', String(body.fleetUnitNumber).trim() || null])
    if (body.internalNotes   != null) updates.push(['internal_notes',    String(body.internalNotes).trim()   || null])

    if (updates.length === 0) return validationError('No valid fields to update.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), vehicleId]
    await db.query(`UPDATE vehicles SET ${set}, updated_at = NOW() WHERE id = ?`, values)

    const [[v]] = await db.query<any[]>(
      `SELECT
         id, rego, rego_state, rego_expiry, vin,
         make, model, series, year, colour,
         body_type, fuel_type, transmission, drive_type,
         engine_code, engine_size_cc, cylinders,
         tyre_size_front, tyre_size_rear, spare_tyre_size,
         odometer_unit, odometer_current, odometer_at_purchase,
         service_interval_km, service_interval_months,
         next_service_due_km, next_service_due_date,
         fleet_unit_number, internal_notes
       FROM vehicles WHERE id = ? LIMIT 1`,
      [vehicleId],
    )

    return ok({
      vehicle: {
        id:                   v.id,
        rego:                 v.rego,
        regoState:            v.rego_state             ?? null,
        regoExpiry:           v.rego_expiry            ? String(v.rego_expiry).slice(0, 10) : null,
        vin:                  v.vin                    ?? null,
        make:                 v.make,
        model:                v.model,
        series:               v.series                 ?? null,
        year:                 v.year,
        colour:               v.colour                 ?? null,
        bodyType:             v.body_type              ?? null,
        fuelType:             v.fuel_type,
        transmission:         v.transmission,
        driveType:            v.drive_type             ?? null,
        engineCode:           v.engine_code            ?? null,
        engineSizeCC:         v.engine_size_cc         ?? null,
        cylinders:            v.cylinders              ?? null,
        tyreSizeFront:        v.tyre_size_front        ?? null,
        tyreSizeRear:         v.tyre_size_rear         ?? null,
        spareTyreSize:        v.spare_tyre_size        ?? null,
        odometerUnit:         v.odometer_unit,
        odometerCurrent:      v.odometer_current       ?? null,
        odometerAtPurchase:   v.odometer_at_purchase   ?? null,
        serviceIntervalKm:    v.service_interval_km    ?? null,
        serviceIntervalMonths: v.service_interval_months ?? null,
        nextServiceDueKm:     v.next_service_due_km    ?? null,
        nextServiceDueDate:   v.next_service_due_date  ? String(v.next_service_due_date).slice(0, 10) : null,
        fleetUnitNumber:      v.fleet_unit_number      ?? null,
        internalNotes:        v.internal_notes         ?? null,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
