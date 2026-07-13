import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { readFromDataLake } from '../../../shared/dataLake'

const ready = bootstrap()

const VALID_CATEGORIES = new Set([
  'fuel','ev_charging','workshop','parts','car_wash','parking',
  'tolls','registration','insurance','roadside','other',
])

// Reads expenses from S3 via s3_event_index. Index lookup filters by vehicle +
// event_type + date range (all indexed columns); category / businessOnly
// filters are applied in-memory after fetching S3 detail. At realistic
// per-vehicle expense counts this is under 200ms end-to-end.
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
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const conditions: string[] = ['vehicle_id = ?', "event_type IN ('fuel-fills', 'expenses')"]
    const params: any[]        = [vehicleId]

    if (q.from) { conditions.push('event_date >= ?'); params.push(q.from) }
    if (q.to)   { conditions.push('event_date <= ?'); params.push(q.to)   }

    const [pointers] = await db.query<any[]>(
      `SELECT id, s3_key, event_date FROM s3_event_index
       WHERE ${conditions.join(' AND ')}
       ORDER BY event_date DESC, id DESC
       LIMIT 200`,
      params,
    )

    const details = await Promise.all(pointers.map((p: any) => readFromDataLake<any>(p.s3_key)))

    const wantCategory     = q.category && VALID_CATEGORIES.has(q.category) ? q.category : null
    const wantBusinessOnly = q.businessOnly === 'true'

    const expenses: any[] = []
    for (let i = 0; i < pointers.length; i++) {
      const p = pointers[i]
      const d = details[i]
      if (!d) continue                                                   // S3 object missing — skip
      if (wantCategory     && d.category !== wantCategory)     continue
      if (wantBusinessOnly && !d.isBusinessExpense)            continue

      expenses.push({
        id:                p.id,                                         // s3_event_index.id is the stable API id
        category:          d.category,
        merchantName:      d.merchantName    ?? null,
        merchantSuburb:    d.merchantSuburb  ?? null,
        merchantState:     d.merchantState   ?? null,
        amountAud:         d.amount          ?? null,
        expenseDate:       d.expenseDate     ?? (p.event_date instanceof Date ? p.event_date.toISOString().slice(0, 10) : String(p.event_date).slice(0, 10)),
        odometerKm:        d.odometerKm      ?? null,
        fuelType:          d.fuelType        ?? null,
        fuelLitres:        d.litres          ?? null,
        pricePerLitre:     d.pricePerLitre   ?? null,
        evKwh:             d.evKwh           ?? null,
        pricePerKwh:       d.pricePerKwh     ?? null,
        imageUrl:          d.imageId ? imageUrls(d.imageId).public : null,
        extractionStatus:  d.extractionStatus ?? 'manual',
        isBusinessExpense: !!d.isBusinessExpense,
        notes:             d.notes ?? null,
        createdAt:         d.createdAt ?? (d.timestamp ?? null),
      })
    }

    return ok({ expenses, total: expenses.length })
  } catch (err) {
    return serverError(err)
  }
}
