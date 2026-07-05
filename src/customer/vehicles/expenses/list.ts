import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'

const ready = bootstrap()

const VALID_CATEGORIES = ['fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const q         = event.queryStringParameters ?? {}

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const conditions: string[] = ['vehicle_id = ?', 'customer_id = ?']
    const params: any[]        = [vehicleId, ctx.customerId]

    if (q.category && VALID_CATEGORIES.includes(q.category)) {
      conditions.push('category = ?')
      params.push(q.category)
    }
    if (q.from) { conditions.push('expense_date >= ?'); params.push(q.from) }
    if (q.to)   { conditions.push('expense_date <= ?'); params.push(q.to)   }
    if (q.businessOnly === 'true') { conditions.push('is_business_expense = 1') }

    const [rows] = await db.query<any[]>(
      `SELECT id, category, merchant_name, merchant_suburb, merchant_state,
              amount_aud, expense_date, odometer_km,
              fuel_type, fuel_litres, price_per_litre,
              ev_kwh, price_per_kwh,
              image_id, extraction_status, is_business_expense, notes, created_at
       FROM vehicle_expenses
       WHERE ${conditions.join(' AND ')}
       ORDER BY expense_date DESC, id DESC
       LIMIT 200`,
      params,
    )

    const expenses = rows.map((r: any) => ({
      id:                r.id,
      category:          r.category,
      merchantName:      r.merchant_name      ?? null,
      merchantSuburb:    r.merchant_suburb    ?? null,
      merchantState:     r.merchant_state     ?? null,
      amountAud:         r.amount_aud         != null ? Number(r.amount_aud)       : null,
      expenseDate:       r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0, 10) : String(r.expense_date).slice(0, 10),
      odometerKm:        r.odometer_km        != null ? Number(r.odometer_km)      : null,
      fuelType:          r.fuel_type          ?? null,
      fuelLitres:        r.fuel_litres        != null ? Number(r.fuel_litres)       : null,
      pricePerLitre:     r.price_per_litre    != null ? Number(r.price_per_litre)   : null,
      evKwh:             r.ev_kwh             != null ? Number(r.ev_kwh)            : null,
      pricePerKwh:       r.price_per_kwh      != null ? Number(r.price_per_kwh)     : null,
      imageUrl:          r.image_id ? imageUrls(r.image_id).public : null,
      extractionStatus:  r.extraction_status,
      isBusinessExpense: !!r.is_business_expense,
      notes:             r.notes ?? null,
      createdAt:         r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }))

    return ok({ expenses, total: expenses.length })
  } catch (err) {
    return serverError(err)
  }
}
