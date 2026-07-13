import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { writeToDataLake } from '../../../shared/dataLake'
import { refreshVehicleSummaries } from '../../../shared/summaries'

const ready = bootstrap()

const VALID_CATEGORIES = new Set(['fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other'])
const VALID_FUEL_TYPES = new Set(['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10'])

// Create is S3-primary: detail goes to S3, an s3_event_index pointer is
// inserted (its id is returned as the expense API id), and per-vehicle
// summary aggregates are refreshed. Nothing goes into vehicle_expenses.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const body = JSON.parse(event.body ?? '{}')
    const {
      category, merchantName, merchantSuburb, merchantState,
      amountAud, expenseDate, odometerKm,
      fuelType, fuelLitres, pricePerLitre,
      evKwh, pricePerKwh,
      imageId, extractionStatus, allFuelPrices,
      isBusinessExpense, notes,
    } = body

    if (!category || !VALID_CATEGORIES.has(category)) return validationError('Valid category is required')
    if (!expenseDate || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return validationError('expenseDate must be YYYY-MM-DD')
    if (fuelType && !VALID_FUEL_TYPES.has(fuelType)) return validationError('Invalid fuelType')

    const isFuel       = category === 'fuel' || category === 'ev_charging'
    const eventType    = isFuel ? 'fuel-fills' : 'expenses'
    const extractionSt = imageId ? (extractionStatus ?? 'extracted') : 'manual'

    const payload = {
      vehicleId,
      customerId:        ctx.customerId,
      category,
      merchantName:      merchantName ? String(merchantName).trim() : null,
      merchantSuburb:    merchantSuburb ? String(merchantSuburb).trim() : null,
      merchantState:     merchantState ? String(merchantState).trim().toUpperCase() : null,
      amount:            amountAud != null ? Number(amountAud) : null,
      expenseDate,
      odometerKm:        odometerKm != null ? Number(odometerKm) : null,
      fuelType:          fuelType ?? null,
      litres:            fuelLitres != null ? Number(fuelLitres) : null,
      pricePerLitre:     pricePerLitre != null ? Number(pricePerLitre) : null,
      evKwh:             evKwh != null ? Number(evKwh) : null,
      pricePerKwh:       pricePerKwh != null ? Number(pricePerKwh) : null,
      imageId:           imageId ?? null,
      extractionStatus:  extractionSt,
      isBusinessExpense: !!isBusinessExpense,
      notes:             notes ? String(notes).trim() : null,
      allFuelPrices:     Array.isArray(allFuelPrices) ? allFuelPrices : null,
      createdAt:         new Date().toISOString(),
    }

    const s3Result = await writeToDataLake(eventType, payload)
    if (!s3Result) return serverError('Data lake write failed')

    const [ins] = await db.query<any>(
      `INSERT INTO s3_event_index (vehicle_id, customer_id, event_type, s3_key, event_date, summary, amount_aud, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [vehicleId, ctx.customerId, eventType, s3Result.key, expenseDate, s3Result.summary, payload.amount, payload.category],
    )
    const expenseId = ins.insertId as number

    await refreshVehicleSummaries(db, vehicleId)

    // Fuel-price intelligence side-effect (unchanged behaviour — writes to
    // fuel_station_prices for the network benchmarking feature). Uses the
    // s3_event_index.id as the "expense_id" foreign key value.
    const pricesToInsert: any[] = []
    const fpMerchant = payload.merchantName
    if (fpMerchant && isFuel && pricePerLitre != null) {
      pricesToInsert.push([expenseId, ctx.customerId, fpMerchant, payload.merchantSuburb, payload.merchantState,
        fuelType ?? 'unleaded_95', Number(pricePerLitre), 'per_litre', imageId ?? null, expenseDate])
    }
    if (fpMerchant && category === 'ev_charging' && pricePerKwh != null) {
      pricesToInsert.push([expenseId, ctx.customerId, fpMerchant, payload.merchantSuburb, payload.merchantState,
        'ev_kwh', Number(pricePerKwh), 'per_kwh', imageId ?? null, expenseDate])
    }
    if (fpMerchant && Array.isArray(allFuelPrices)) {
      for (const fp of allFuelPrices) {
        if (fp.fuelType && fp.pricePerLitre != null) {
          pricesToInsert.push([expenseId, ctx.customerId, fpMerchant, payload.merchantSuburb, payload.merchantState,
            fp.fuelType, Number(fp.pricePerLitre), 'per_litre', imageId ?? null, expenseDate])
        }
      }
    }
    if (pricesToInsert.length) {
      const placeholders = pricesToInsert.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
      await db.query(
        `INSERT INTO fuel_station_prices (expense_id, customer_id, station_name, station_suburb, station_state, fuel_type, price, price_unit, image_id, reported_at) VALUES ${placeholders}`,
        pricesToInsert.flat(),
      ).catch(() => {}) // non-fatal
    }

    if (category === 'workshop') {
      await db.query(
        `INSERT INTO vehicle_service_log_external
           (vehicle_id, customer_id, image_id, workshop_name, workshop_suburb,
            service_date, odometer_km, services, amount_aud, status)
         VALUES (?,?,?,?,?,?,?,?,?,'extracted')`,
        [vehicleId, ctx.customerId, imageId ?? null, payload.merchantName, payload.merchantSuburb,
         expenseDate, payload.odometerKm, payload.notes, payload.amount],
      ).catch(() => {})
    }

    return created({
      id:                expenseId,
      category:          payload.category,
      merchantName:      payload.merchantName,
      merchantSuburb:    payload.merchantSuburb,
      merchantState:     payload.merchantState,
      amountAud:         payload.amount,
      expenseDate:       payload.expenseDate,
      odometerKm:        payload.odometerKm,
      fuelType:          payload.fuelType,
      fuelLitres:        payload.litres,
      pricePerLitre:     payload.pricePerLitre,
      evKwh:             payload.evKwh,
      pricePerKwh:       payload.pricePerKwh,
      imageUrl:          payload.imageId ? imageUrls(payload.imageId).public : null,
      extractionStatus:  payload.extractionStatus,
      isBusinessExpense: payload.isBusinessExpense,
      notes:             payload.notes,
      createdAt:         payload.createdAt,
    })
  } catch (err) {
    return serverError(err)
  }
}
