import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { refreshVehicleSummaries } from '../../../shared/summaries'

const ready = bootstrap()

const VALID_CATEGORIES = ['fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other']
const VALID_FUEL_TYPES = ['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const expenseId = Number(event.pathParameters?.expenseId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicle_expenses WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [expenseId, vehicleId, ctx.customerId],
    )
    if (!existing) return notFound('Expense')

    const body = JSON.parse(event.body ?? '{}')
    const {
      category, merchantName, merchantSuburb, merchantState,
      amountAud, expenseDate, odometerKm,
      fuelType, fuelLitres, pricePerLitre,
      evKwh, pricePerKwh,
      isBusinessExpense, notes,
    } = body

    if (category != null && !VALID_CATEGORIES.includes(category)) return validationError('Invalid category')
    if (expenseDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return validationError('expenseDate must be YYYY-MM-DD')
    if (fuelType != null && !VALID_FUEL_TYPES.includes(fuelType)) return validationError('Invalid fuelType')

    const sets: string[] = ['updated_at = NOW()']
    const params: any[]  = []

    if (category        != null) { sets.push('category = ?');          params.push(category) }
    if (merchantName    != null) { sets.push('merchant_name = ?');     params.push(String(merchantName).trim() || null) }
    if (merchantSuburb  != null) { sets.push('merchant_suburb = ?');   params.push(String(merchantSuburb).trim() || null) }
    if (merchantState   != null) { sets.push('merchant_state = ?');    params.push(String(merchantState).trim().toUpperCase() || null) }
    if (amountAud       != null) { sets.push('amount_aud = ?');        params.push(Number(amountAud)) }
    if (expenseDate     != null) { sets.push('expense_date = ?');      params.push(expenseDate) }
    if (odometerKm      != null) { sets.push('odometer_km = ?');       params.push(Number(odometerKm)) }
    if (fuelType        != null) { sets.push('fuel_type = ?');         params.push(fuelType) }
    if (fuelLitres      != null) { sets.push('fuel_litres = ?');       params.push(Number(fuelLitres)) }
    if (pricePerLitre   != null) { sets.push('price_per_litre = ?');   params.push(Number(pricePerLitre)) }
    if (evKwh           != null) { sets.push('ev_kwh = ?');            params.push(Number(evKwh)) }
    if (pricePerKwh     != null) { sets.push('price_per_kwh = ?');     params.push(Number(pricePerKwh)) }
    if (isBusinessExpense != null) { sets.push('is_business_expense = ?'); params.push(isBusinessExpense ? 1 : 0) }
    if (notes           != null) { sets.push('notes = ?');             params.push(String(notes).trim() || null) }

    if (params.length > 0) {
      params.push(expenseId)
      await db.query(`UPDATE vehicle_expenses SET ${sets.join(', ')} WHERE id = ?`, params)
      await refreshVehicleSummaries(db, vehicleId)
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
    if (!row) return notFound('Expense')

    return ok({
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
