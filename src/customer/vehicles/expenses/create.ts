import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'

const ready = bootstrap()

const VALID_CATEGORIES = ['fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other']
const VALID_FUEL_TYPES = ['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10']

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

    const body = JSON.parse(event.body ?? '{}')
    const {
      category, merchantName, merchantSuburb, merchantState,
      amountAud, expenseDate, odometerKm,
      fuelType, fuelLitres, pricePerLitre,
      evKwh, pricePerKwh,
      imageId, extractionStatus, allFuelPrices,
      isBusinessExpense, notes,
    } = body

    if (!category || !VALID_CATEGORIES.includes(category)) return validationError('Valid category is required')
    if (!expenseDate || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return validationError('expenseDate must be YYYY-MM-DD')
    if (fuelType && !VALID_FUEL_TYPES.includes(fuelType)) return validationError('Invalid fuelType')

    const status = imageId ? (extractionStatus ?? 'extracted') : 'manual'

    const [result] = await db.query<any>(
      `INSERT INTO vehicle_expenses
         (vehicle_id, customer_id, category, merchant_name, merchant_suburb, merchant_state,
          amount_aud, expense_date, odometer_km, fuel_type, fuel_litres, price_per_litre,
          ev_kwh, price_per_kwh, image_id, extraction_status, is_business_expense, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        vehicleId, ctx.customerId, category,
        merchantName ? String(merchantName).trim() : null,
        merchantSuburb ? String(merchantSuburb).trim() : null,
        merchantState ? String(merchantState).trim().toUpperCase() : null,
        amountAud != null ? Number(amountAud) : null,
        expenseDate,
        odometerKm != null ? Number(odometerKm) : null,
        fuelType ?? null,
        fuelLitres != null ? Number(fuelLitres) : null,
        pricePerLitre != null ? Number(pricePerLitre) : null,
        evKwh != null ? Number(evKwh) : null,
        pricePerKwh != null ? Number(pricePerKwh) : null,
        imageId ?? null,
        status,
        isBusinessExpense ? 1 : 0,
        notes ? String(notes).trim() : null,
      ],
    )
    const expenseId = result.insertId

    // Contribute to fuel price intelligence when price data is present
    const pricesToInsert: any[] = []

    if ((category === 'fuel' || category === 'ev_charging') && pricePerLitre != null && merchantName) {
      pricesToInsert.push([
        expenseId, ctx.customerId, merchantName, merchantSuburb ?? null, merchantState ?? null,
        fuelType ?? 'unleaded_95', Number(pricePerLitre), 'per_litre', imageId ?? null, expenseDate,
      ])
    }
    if (category === 'ev_charging' && pricePerKwh != null && merchantName) {
      pricesToInsert.push([
        expenseId, ctx.customerId, merchantName, merchantSuburb ?? null, merchantState ?? null,
        'ev_kwh', Number(pricePerKwh), 'per_kwh', imageId ?? null, expenseDate,
      ])
    }
    // Pump photo: multiple fuel types from allFuelPrices
    if (Array.isArray(allFuelPrices) && merchantName) {
      for (const fp of allFuelPrices) {
        if (fp.fuelType && fp.pricePerLitre != null) {
          pricesToInsert.push([
            expenseId, ctx.customerId, merchantName, merchantSuburb ?? null, merchantState ?? null,
            fp.fuelType, Number(fp.pricePerLitre), 'per_litre', imageId ?? null, expenseDate,
          ])
        }
      }
    }

    if (pricesToInsert.length) {
      const placeholders = pricesToInsert.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
      await db.query(
        `INSERT INTO fuel_station_prices (expense_id, customer_id, station_name, station_suburb, station_state, fuel_type, price, price_unit, image_id, reported_at) VALUES ${placeholders}`,
        pricesToInsert.flat(),
      )
    }

    // If workshop invoice, also write to logbook
    if (category === 'workshop') {
      await db.query(
        `INSERT INTO vehicle_service_log_external
           (vehicle_id, customer_id, image_id, workshop_name, workshop_suburb,
            service_date, odometer_km, services, amount_aud, status)
         VALUES (?,?,?,?,?,?,?,?,?,'extracted')`,
        [
          vehicleId, ctx.customerId, imageId ?? null,
          merchantName ? String(merchantName).trim() : null,
          merchantSuburb ? String(merchantSuburb).trim() : null,
          expenseDate,
          odometerKm != null ? Number(odometerKm) : null,
          notes ? String(notes).trim() : null,
          amountAud != null ? Number(amountAud) : null,
        ],
      ).catch(() => {}) // non-fatal if logbook table doesn't exist yet
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, category, merchant_name, merchant_suburb, merchant_state,
              amount_aud, expense_date, odometer_km,
              fuel_type, fuel_litres, price_per_litre,
              ev_kwh, price_per_kwh,
              image_id, extraction_status, is_business_expense, notes, created_at
       FROM vehicle_expenses WHERE id = ? LIMIT 1`,
      [expenseId],
    )

    return created({
      id:                row.id,
      category:          row.category,
      merchantName:      row.merchant_name    ?? null,
      merchantSuburb:    row.merchant_suburb  ?? null,
      merchantState:     row.merchant_state   ?? null,
      amountAud:         row.amount_aud       != null ? Number(row.amount_aud)     : null,
      expenseDate:       row.expense_date instanceof Date ? row.expense_date.toISOString().slice(0, 10) : String(row.expense_date).slice(0, 10),
      odometerKm:        row.odometer_km      != null ? Number(row.odometer_km)    : null,
      fuelType:          row.fuel_type        ?? null,
      fuelLitres:        row.fuel_litres      != null ? Number(row.fuel_litres)     : null,
      pricePerLitre:     row.price_per_litre  != null ? Number(row.price_per_litre) : null,
      evKwh:             row.ev_kwh           != null ? Number(row.ev_kwh)          : null,
      pricePerKwh:       row.price_per_kwh    != null ? Number(row.price_per_kwh)   : null,
      imageUrl:          row.image_id ? imageUrls(row.image_id).public : null,
      extractionStatus:  row.extraction_status,
      isBusinessExpense: !!row.is_business_expense,
      notes:             row.notes ?? null,
      createdAt:         row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    })
  } catch (err) {
    return serverError(err)
  }
}
