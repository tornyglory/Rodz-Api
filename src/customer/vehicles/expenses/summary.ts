import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { readFromDataLake } from '../../../shared/dataLake'
import { loadWorkshopInvoiceExpenses } from './_workshopInvoices'

const ready = bootstrap()

// Reads YTD expense aggregates from s3_event_index (fast, no S3 GETs for
// category/monthly totals — amount_aud + category are denormalised on the
// index). Fetches S3 objects in parallel for business flag + fuel efficiency,
// which need fields not on the index.
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

    const [[pointers], workshopInvoices] = await Promise.all([
      db.query<any[]>(
        `SELECT id, s3_key, event_date, event_type, category, amount_aud
         FROM s3_event_index
         WHERE vehicle_id = ? AND customer_id = ?
           AND event_type IN ('fuel-fills', 'expenses')
           AND event_date BETWEEN ? AND ?
         ORDER BY event_date ASC`,
        [vehicleId, ctx.customerId, fromDate, toDate],
      ),
      loadWorkshopInvoiceExpenses(db, { vehicleId, customerId: ctx.customerId, from: fromDate, to: toDate }),
    ])

    // Category / monthly / total — pure SQL-level rollups, no S3 GET needed.
    const byCategoryMap = new Map<string, { total: number; count: number }>()
    const byMonthMap    = new Map<string, number>()
    let totalAud = 0

    const bumpBuckets = (amtRaw: number | string | null, catRaw: string | null, dateInput: any) => {
      const amt = amtRaw != null ? Number(amtRaw) : 0
      const cat = catRaw || 'other'
      totalAud += amt
      const bc = byCategoryMap.get(cat) ?? { total: 0, count: 0 }
      bc.total += amt
      bc.count += 1
      byCategoryMap.set(cat, bc)
      const d     = dateInput instanceof Date ? dateInput : new Date(dateInput)
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      byMonthMap.set(month, (byMonthMap.get(month) ?? 0) + amt)
    }

    for (const p of pointers) bumpBuckets(p.amount_aud, p.category, p.event_date)
    for (const w of workshopInvoices) bumpBuckets(w.amountAud, 'workshop', w.expenseDate)

    // Business-total + fuel efficiency need per-object fields. Fetch S3
    // objects in parallel — at realistic volume this is <50ms total.
    const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))

    let businessTotalAud = 0
    const fuelRows: Array<{ odometer: number; litres: number; amount: number }> = []

    for (let i = 0; i < pointers.length; i++) {
      const p = pointers[i]
      const d = details[i]
      if (!d) continue
      if (d.isBusinessExpense) businessTotalAud += Number(d.amount ?? 0)

      if (p.event_type === 'fuel-fills' && d.category === 'fuel' && d.odometerKm != null && d.litres != null) {
        fuelRows.push({
          odometer: Number(d.odometerKm),
          litres:   Number(d.litres),
          amount:   Number(d.amount ?? 0),
        })
      }
    }

    let fuelEfficiency: any = null
    if (fuelRows.length >= 2) {
      fuelRows.sort((a, b) => a.odometer - b.odometer)
      const totalLitres = fuelRows.reduce((s, r) => s + r.litres, 0)
      const totalFuelAud = fuelRows.reduce((s, r) => s + r.amount, 0)
      const kmSpan      = fuelRows[fuelRows.length - 1].odometer - fuelRows[0].odometer
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

    const byCategory = Array.from(byCategoryMap.entries())
      .map(([category, { total, count }]) => ({
        category,
        totalAud: Math.round(total * 100) / 100,
        count,
      }))
      .sort((a, b) => b.totalAud - a.totalAud)

    const monthlyTotals = Array.from(byMonthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, total]) => ({
        month,
        totalAud: Math.round(total * 100) / 100,
      }))

    return ok({
      year,
      totalAud:         Math.round(totalAud * 100) / 100,
      businessTotalAud: Math.round(businessTotalAud * 100) / 100,
      byCategory,
      fuelEfficiency,
      monthlyTotals,
    })
  } catch (err) {
    return serverError(err)
  }
}
