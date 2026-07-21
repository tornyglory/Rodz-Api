import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, serverError } from '../shared/errors'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import { shapeModification, shapeMedia, ModificationMedia } from '../customer/vehicles/modifications/_helpers'

const ready = bootstrap()

// GET /logbook/{token}/modifications
//
// Public modifications feed for the anonymous logbook page. Two gates:
//   1. Vehicle-level: `public_profile_settings.modifications` must not be false.
//   2. Row-level: only mods where `is_public = 1` and `deleted_at IS NULL`.
//
// Media is limited to `kind = 'photo'` so receipt scans stay private, but
// receipt amounts still feed the aggregate `totalReceiptSpend` — the resale
// trust-signal banner ("$X in aftermarket parts, receipts attached") from
// the mods brief needs the total without exposing individual scans.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, is_active, public_profile_settings FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.modifications) return ok({ modifications: [] })

    const [rows] = await db.query<any[]>(
      `SELECT id, vehicle_id, category, name, brand, description, installed_at, installed_by,
              cost_aud, status, removed_at, kept_with_sale, is_public, cover_image_id,
              created_at, updated_at
       FROM vehicle_modifications
       WHERE vehicle_id = ? AND is_public = 1 AND deleted_at IS NULL
       ORDER BY category ASC, id DESC`,
      [vehicle.id],
    )

    const ids = rows.map((r: any) => Number(r.id))
    const mediaByMod = new Map<number, ModificationMedia[]>()
    const receiptsByMod = new Map<number, ModificationMedia[]>()

    if (ids.length > 0) {
      const [mediaRows] = await db.query<any[]>(
        `SELECT id, modification_id, kind, image_id, caption, sort_order, amount_aud,
                supplier, purchased_at, expense_event_id, created_at
         FROM vehicle_modification_media
         WHERE modification_id IN (?)
         ORDER BY sort_order ASC, id ASC`,
        [ids],
      )
      for (const r of mediaRows) {
        const modId = Number(r.modification_id)
        const shaped = shapeMedia(r)
        if (shaped.kind === 'photo') {
          if (!mediaByMod.has(modId)) mediaByMod.set(modId, [])
          mediaByMod.get(modId)!.push(shaped)
        } else {
          if (!receiptsByMod.has(modId)) receiptsByMod.set(modId, [])
          receiptsByMod.get(modId)!.push(shaped)
        }
      }
    }

    const modifications = rows.map((r: any) => {
      const modId = Number(r.id)
      const shaped = shapeModification(r, mediaByMod.get(modId) ?? [])
      const receipts = receiptsByMod.get(modId) ?? []
      const totalReceiptSpend = receipts.reduce((sum, x) => sum + (x.amountAud ?? 0), 0)
      shaped.receiptCount = receipts.length
      shaped.totalReceiptSpend = totalReceiptSpend > 0 ? totalReceiptSpend : null
      return shaped
    })

    return ok({ modifications })
  } catch (err) {
    return serverError(err)
  }
}
