import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { computeSlotAvailability, toHHMM } from '../../shared/bookingSlots'
import { imageUrls } from '../../shared/cloudflare'

const ready = bootstrap()

// GET /c/stores/{id}/booking-slots?date=YYYY-MM-DD&serviceTypeIds=1,2
//
// Returns each configured slot for the store with `available` + a `techs`
// array (per hoist that's free at that time, joined to the assigned
// technician). If `serviceTypeIds` is passed as a comma-separated list,
// only hoists whose service_roles cover every requested service are
// returned in `techs`.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const storeId = Number(event.pathParameters?.id)
  const q       = event.queryStringParameters ?? {}
  const date    = q.date

  if (!storeId) return validationError('store id is required.')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return validationError('date query param must be YYYY-MM-DD format.')
  }

  // Parse `serviceTypeIds` — accepts either repeated `?serviceTypeIds=1&serviceTypeIds=2`
  // (comes through as one comma-joined string in APIGW v2) or a single CSV value.
  const raw = q.serviceTypeIds ?? ''
  const serviceTypeIds = raw
    ? String(raw).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : undefined

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeId],
    )
    if (!store) return notFound('Store')

    const result = await computeSlotAvailability(db, storeId, date, serviceTypeIds)

    return ok({
      store:           { id: Number(store.id), name: store.name },
      date,
      storeOpen:       result.storeOpen,
      reason:          result.reason ?? null,
      exceptionReason: result.exceptionReason ?? null,
      slots:           result.slots.map(s => ({
        id:        s.id,
        time:      toHHMM(s.time),
        endTime:   toHHMM(s.endTime),
        label:     s.label,
        sortOrder: s.sortOrder,
        available: s.available,
        reason:    (s as any).reason ?? null,
        techs:     (s.techs ?? []).map(t => ({
          hoistId:   t.hoistId,
          hoistName: t.hoistName,
          staffId:   t.staffId,
          name:      t.name,            // null when the hoist has no assigned tech
          avatarUrl: t.avatarImageId ? imageUrls(t.avatarImageId).thumbnail : null,
        })),
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
