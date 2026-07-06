import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const q         = event.queryStringParameters ?? {}
  const year      = q.year ? Number(q.year) : new Date().getFullYear()

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const fromDate = `${year}-01-01`
    const toDate   = `${year}-12-31`

    const [categoryRows] = await db.query<any[]>(
      `SELECT category, SUM(amount_aud) AS total, COUNT(*) AS cnt
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND expense_date BETWEEN ? AND ? AND amount_aud IS NOT NULL
       GROUP BY category
       ORDER BY total DESC`,
      [vehicleId, ctx.customerId, fromDate, toDate],
    )

    const [businessRow] = await db.query<any[]>(
      `SELECT SUM(amount_aud) AS total
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND expense_date BETWEEN ? AND ?
         AND is_business_expense = 1 AND amount_aud IS NOT NULL`,
      [vehicleId, ctx.customerId, fromDate, toDate],
    )

    const [monthlyRows] = await db.query<any[]>(
      `SELECT DATE_FORMAT(expense_date, '%Y-%m') AS month, SUM(amount_aud) AS total
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND expense_date BETWEEN ? AND ? AND amount_aud IS NOT NULL
       GROUP BY month ORDER BY month`,
      [vehicleId, ctx.customerId, fromDate, toDate],
    )

    // Fuel efficiency — needs consecutive odometer readings on fuel entries
    const [fuelRows] = await db.query<any[]>(
      `SELECT odometer_km, fuel_litres, amount_aud
       FROM vehicle_expenses
       WHERE vehicle_id = ? AND customer_id = ? AND category = 'fuel'
         AND expense_date BETWEEN ? AND ?
         AND odometer_km IS NOT NULL AND fuel_litres IS NOT NULL
       ORDER BY odometer_km ASC`,
      [vehicleId, ctx.customerId, fromDate, toDate],
    )

    let fuelEfficiency: any = null
    if (fuelRows.length >= 2) {
      const totalLitres = fuelRows.reduce((s: number, r: any) => s + Number(r.fuel_litres), 0)
      const totalFuelAud = fuelRows.reduce((s: number, r: any) => s + (r.amount_aud ? Number(r.amount_aud) : 0), 0)
      const kmSpan = Number(fuelRows[fuelRows.length - 1].odometer_km) - Number(fuelRows[0].odometer_km)
      if (kmSpan > 0) {
        const avgL100km  = (totalLitres / kmSpan) * 100
        const costPerKm  = totalFuelAud / kmSpan
        fuelEfficiency = {
          avgLitresPer100km: Math.round(avgL100km * 10) / 10,
          totalLitres:       Math.round(totalLitres * 10) / 10,
          totalFuelAud:      Math.round(totalFuelAud * 100) / 100,
          costPerKm:         Math.round(costPerKm * 100) / 100,
        }
      }
    }

    const totalAud = categoryRows.reduce((s: number, r: any) => s + Number(r.total), 0)

    return ok({
      year,
      totalAud:         Math.round(totalAud * 100) / 100,
      businessTotalAud: Number(businessRow[0]?.total ?? 0),
      byCategory:       categoryRows.map((r: any) => ({
        category:  r.category,
        totalAud:  Math.round(Number(r.total) * 100) / 100,
        count:     Number(r.cnt),
      })),
      fuelEfficiency,
      monthlyTotals: monthlyRows.map((r: any) => ({
        month:    r.month,
        totalAud: Math.round(Number(r.total) * 100) / 100,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
