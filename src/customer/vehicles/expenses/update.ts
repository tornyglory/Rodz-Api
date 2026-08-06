import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { refreshVehicleSummaries } from '../../../shared/summaries'
import { readFromDataLake, overwriteInDataLake } from '../../../shared/dataLake'
import { bumpOdometer } from '../../../shared/odometer'

const ready = bootstrap()

const VALID_CATEGORIES = new Set(['fuel','ev_charging','workshop','parts','modification','car_wash','parking','tolls','registration','insurance','roadside','other'])
const VALID_FUEL_TYPES = new Set(['unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10'])

// Update: identifies the expense by s3_event_index.id (the API's stable id).
// Reads the current S3 object, merges patch fields, rewrites at the same key,
// then refreshes the vehicle's summary aggregates.
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

    const [[pointer]] = await db.query<any[]>(
      `SELECT id, s3_key, event_date, event_type FROM s3_event_index
       WHERE id = ? AND vehicle_id = ? AND customer_id = ?
         AND event_type IN ('fuel-fills','expenses') LIMIT 1`,
      [expenseId, vehicleId, ctx.customerId],
    )
    if (!pointer) return notFound('Expense')

    const current = await readFromDataLake<any>(pointer.s3_key)
    if (!current) return notFound('Expense')

    const body = JSON.parse(event.body ?? '{}')
    if (body.category    != null && !VALID_CATEGORIES.has(body.category)) return validationError('Invalid category')
    if (body.fuelType    != null && !VALID_FUEL_TYPES.has(body.fuelType)) return validationError('Invalid fuelType')
    if (body.expenseDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.expenseDate)) return validationError('expenseDate must be YYYY-MM-DD')

    // Merge only the patch fields — everything else stays as-is.
    const merged = { ...current }
    for (const [inputKey, targetKey] of [
      ['category',        'category'],
      ['merchantName',    'merchantName'],
      ['merchantSuburb',  'merchantSuburb'],
      ['merchantState',   'merchantState'],
      ['amountAud',       'amount'],
      ['expenseDate',     'expenseDate'],
      ['odometerKm',      'odometerKm'],
      ['fuelType',        'fuelType'],
      ['fuelLitres',      'litres'],
      ['pricePerLitre',   'pricePerLitre'],
      ['evKwh',           'evKwh'],
      ['pricePerKwh',     'pricePerKwh'],
      ['isBusinessExpense','isBusinessExpense'],
      ['notes',           'notes'],
    ] as const) {
      if (body[inputKey] !== undefined) merged[targetKey] = body[inputKey]
    }
    merged.updatedAt = new Date().toISOString()

    // Recompute event_type in case category changed fuel <-> non-fuel.
    const newIsFuel     = merged.category === 'fuel' || merged.category === 'ev_charging'
    const newEventType  = newIsFuel ? 'fuel-fills' : 'expenses'

    const write = await overwriteInDataLake(pointer.s3_key, newEventType, merged)
    if (!write) return serverError('S3 write failed')

    // Update the index row to reflect the new state.
    await db.query(
      `UPDATE s3_event_index
         SET event_type = ?, event_date = ?, summary = ?, amount_aud = ?, category = ?
       WHERE id = ?`,
      [newEventType, merged.expenseDate ?? pointer.event_date, write.summary, merged.amount ?? null, merged.category ?? null, expenseId],
    )
    await refreshVehicleSummaries(db, vehicleId)

    // Ratchet vehicle odometer forward if the (possibly patched) reading
    // is newer than what we have.
    if (merged.odometerKm != null) {
      const source = newIsFuel ? 'fuel-fill' : 'expense'
      await bumpOdometer(db, vehicleId, Number(merged.odometerKm), source, {
        actorType: 'customer',
        actorId:   Number(ctx.customerId) || null,
        sourceRef: `expense:${expenseId}`,
      }).catch(err =>
        console.error(`odometer ratchet from ${source} update failed for vehicle ${vehicleId}:`, err),
      )
    }

    return ok({
      id:                expenseId,
      category:          merged.category,
      merchantName:      merged.merchantName    ?? null,
      merchantSuburb:    merged.merchantSuburb  ?? null,
      merchantState:     merged.merchantState   ?? null,
      amountAud:         merged.amount          ?? null,
      expenseDate:       merged.expenseDate,
      odometerKm:        merged.odometerKm      ?? null,
      fuelType:          merged.fuelType        ?? null,
      fuelLitres:        merged.litres          ?? null,
      pricePerLitre:     merged.pricePerLitre   ?? null,
      evKwh:             merged.evKwh           ?? null,
      pricePerKwh:       merged.pricePerKwh     ?? null,
      imageUrl:          merged.imageId ? imageUrls(merged.imageId).public : null,
      extractionStatus:  merged.extractionStatus ?? 'manual',
      isBusinessExpense: !!merged.isBusinessExpense,
      notes:             merged.notes ?? null,
      createdAt:         merged.createdAt ?? merged.timestamp ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
