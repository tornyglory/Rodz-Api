import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, gone, notFound, validationError, serverError } from '../../shared/errors'
import { maybeRegenerateSchedule } from '../../shared/aiEngines'
import { verifyImage, deleteCloudflareImage } from '../../shared/cloudflare'
import { safeDel } from '../../shared/redis'
import { bumpOdometer } from '../../shared/odometer'
import {
  sanitiseSettingsPatch,
  mergePublicProfileSettings,
  PUBLIC_PROFILE_DEFAULTS,
} from '../../shared/publicProfileSettings'
import { loadVehicleForResponse } from './_helpers'

const ready = bootstrap()

const VALID_BODY_TYPE    = new Set(['sedan','hatch','wagon','ute','van','suv','coupe','convertible','truck','other'])
const VALID_FUEL_TYPE    = new Set(['petrol','diesel','hybrid','electric','lpg','other'])
const VALID_TRANSMISSION = new Set(['manual','automatic','cvt','dct','other'])
const VALID_DRIVE_TYPE   = new Set(['fwd','rwd','awd','4wd'])
const VALID_REGO_STATE   = new Set(['VIC','NSW','QLD','SA','WA','TAS','NT','ACT'])
const VALID_ODOM_UNIT    = new Set(['km','mi'])

const DESCRIPTION_MAX = 2000
const CITY_MAX        = 120
const COUNTRY_MAX     = 120

const PUBLIC_SETTINGS_KEYS = new Set(Object.keys(PUBLIC_PROFILE_DEFAULTS))

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[vRow]] = await db.query<any[]>(
      `SELECT v.is_active, v.avatar_image_id, v.cover_image_id, v.avatar_illustration_image_id
         FROM vehicles v
         JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
        WHERE v.id = ? AND vo.customer_id = ?
        LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vRow)          return notFound('Vehicle')
    if (!vRow.is_active) return gone('Vehicle')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const updates: [string, unknown][] = []

    // ── Identity ───────────────────────────────────────────────────────────
    if (body.rego != null)
      updates.push(['rego', String(body.rego).trim().toUpperCase()])

    if (body.regoState != null) {
      const v = String(body.regoState).toUpperCase()
      if (!VALID_REGO_STATE.has(v)) return validationError('Invalid regoState.')
      updates.push(['rego_state', v])
    }

    if (body.regoExpiry != null)
      updates.push(['rego_expiry', String(body.regoExpiry)])

    if (body.vin != null)
      updates.push(['vin', String(body.vin).trim().toUpperCase() || null])

    // ── Specs ──────────────────────────────────────────────────────────────
    if (body.make  != null) updates.push(['make',  String(body.make).trim()])
    if (body.model != null) updates.push(['model', String(body.model).trim()])
    if (body.series != null) updates.push(['series', String(body.series).trim() || null])
    if (body.year  != null) updates.push(['year',  Number(body.year)])
    if (body.colour != null) updates.push(['colour', String(body.colour).trim() || null])

    if (body.bodyType != null) {
      const v = String(body.bodyType)
      if (!VALID_BODY_TYPE.has(v)) return validationError('Invalid bodyType.')
      updates.push(['body_type', v])
    }

    if (body.fuelType != null) {
      const v = String(body.fuelType)
      if (!VALID_FUEL_TYPE.has(v)) return validationError('Invalid fuelType.')
      updates.push(['fuel_type', v])
    }

    if (body.transmission != null) {
      const v = String(body.transmission)
      if (!VALID_TRANSMISSION.has(v)) return validationError('Invalid transmission.')
      updates.push(['transmission', v])
    }

    if (body.driveType != null) {
      const v = String(body.driveType)
      if (!VALID_DRIVE_TYPE.has(v)) return validationError('Invalid driveType.')
      updates.push(['drive_type', v])
    }

    if (body.engineCode    != null) updates.push(['engine_code',    String(body.engineCode).trim() || null])
    if (body.engineSizeCC  != null) updates.push(['engine_size_cc', Number(body.engineSizeCC) || null])
    if (body.cylinders     != null) updates.push(['cylinders',      Number(body.cylinders) || null])

    // ── Tyres ──────────────────────────────────────────────────────────────
    if (body.tyreSizeFront != null) updates.push(['tyre_size_front', String(body.tyreSizeFront).trim() || null])
    if (body.tyreSizeRear  != null) updates.push(['tyre_size_rear',  String(body.tyreSizeRear).trim()  || null])
    if (body.spareTyreSize != null) updates.push(['spare_tyre_size', String(body.spareTyreSize).trim() || null])

    // ── Odometer ───────────────────────────────────────────────────────────
    if (body.odometerUnit != null) {
      const v = String(body.odometerUnit)
      if (!VALID_ODOM_UNIT.has(v)) return validationError('Invalid odometerUnit.')
      updates.push(['odometer_unit', v])
    }

    // odometerCurrent goes through bumpOdometer() below so it can never
    // decrease. Handled outside the `updates` set for the same reason.
    if (body.odometerAtPurchase != null) updates.push(['odometer_at_purchase', Number(body.odometerAtPurchase)])

    // ── Service intervals ──────────────────────────────────────────────────
    if (body.serviceIntervalKm     != null) updates.push(['service_interval_km',     Number(body.serviceIntervalKm)])
    if (body.serviceIntervalMonths != null) updates.push(['service_interval_months', Number(body.serviceIntervalMonths)])
    if (body.nextServiceDueKm      != null) updates.push(['next_service_due_km',     Number(body.nextServiceDueKm)])
    if (body.nextServiceDueDate    != null) updates.push(['next_service_due_date',   String(body.nextServiceDueDate)])

    // ── Other ──────────────────────────────────────────────────────────────
    if (body.fleetUnitNumber != null) updates.push(['fleet_unit_number', String(body.fleetUnitNumber).trim() || null])
    if (body.internalNotes   != null) updates.push(['internal_notes',    String(body.internalNotes).trim()   || null])

    // ── Profile — description ──────────────────────────────────────────────
    if ('description' in body) {
      const raw = body.description
      if (raw === null || raw === '') {
        updates.push(['description', null])
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed.length > DESCRIPTION_MAX) {
          return validationError(`description must be ${DESCRIPTION_MAX} characters or fewer.`)
        }
        updates.push(['description', trimmed.length ? trimmed : null])
      } else {
        return validationError('description must be a string or null.')
      }
    }

    // ── Profile — for-sale + location ──────────────────────────────────────
    if ('forSale' in body) {
      updates.push(['for_sale', body.forSale ? 1 : 0])
    }

    if ('askingPrice' in body) {
      if (body.askingPrice === null) {
        updates.push(['asking_price', null])
      } else {
        const n = Number(body.askingPrice)
        if (!Number.isFinite(n) || n < 0) return validationError('askingPrice must be a non-negative integer.')
        updates.push(['asking_price', Math.floor(n)])
      }
    }

    if ('city' in body) {
      if (body.city === null) {
        updates.push(['city', null])
      } else {
        const s = String(body.city).trim()
        if (s.length > CITY_MAX) return validationError(`city must be ${CITY_MAX} characters or fewer.`)
        updates.push(['city', s.length ? s : null])
      }
    }

    if ('country' in body) {
      if (body.country === null) {
        updates.push(['country', null])
      } else {
        const s = String(body.country).trim()
        if (s.length > COUNTRY_MAX) return validationError(`country must be ${COUNTRY_MAX} characters or fewer.`)
        updates.push(['country', s.length ? s : null])
      }
    }

    // ── Profile — publicProfileSettings (merged separately from column set) ─
    let settingsPatch: ReturnType<typeof sanitiseSettingsPatch> = null
    if ('publicProfileSettings' in body) {
      const raw = body.publicProfileSettings
      const keyList = [...PUBLIC_SETTINGS_KEYS].join(', ')
      if (!raw || typeof raw !== 'object') {
        return validationError(`publicProfileSettings must be an object of boolean keys (${keyList}).`)
      }
      for (const key of Object.keys(raw as Record<string, unknown>)) {
        if (!PUBLIC_SETTINGS_KEYS.has(key)) {
          return validationError(`publicProfileSettings contains unknown key: ${key}.`)
        }
      }
      settingsPatch = sanitiseSettingsPatch(raw)
      if (!settingsPatch) {
        return validationError(`publicProfileSettings must contain at least one boolean key (${keyList}).`)
      }
    }

    // ── Profile — avatar / cover image ids ─────────────────────────────────
    // Verify BEFORE running the UPDATE so a bad image id doesn't clobber the
    // row and leave the previous file orphaned.
    let previousAvatarId: string | null = null
    let previousCoverId:  string | null = null

    if ('avatarImageId' in body) {
      const raw = body.avatarImageId
      if (raw === null) {
        updates.push(['avatar_image_id', null])
      } else if (typeof raw === 'string' && raw) {
        const exists = await verifyImage(raw)
        if (!exists) return validationError('avatarImageId not found in Cloudflare.')
        previousAvatarId = vRow.avatar_image_id ?? null
        updates.push(['avatar_image_id', raw])
      } else {
        return validationError('avatarImageId must be a non-empty string or null.')
      }
    }

    if ('coverImageId' in body) {
      const raw = body.coverImageId
      if (raw === null) {
        updates.push(['cover_image_id', null])
      } else if (typeof raw === 'string' && raw) {
        const exists = await verifyImage(raw)
        if (!exists) return validationError('coverImageId not found in Cloudflare.')
        previousCoverId = vRow.cover_image_id ?? null
        updates.push(['cover_image_id', raw])
      } else {
        return validationError('coverImageId must be a non-empty string or null.')
      }
    }

    // Illustrated version of the avatar (Nano Banana output). Nullable
    // so the frontend can revert to the raw photo. Not verified against
    // Cloudflare — trusted because it was just returned by our own
    // /images/illustrate endpoint (and unverified strings would just
    // 404 in the render path, harmless).
    if ('avatarIllustrationImageId' in body) {
      const raw = body.avatarIllustrationImageId
      if (raw === null) {
        updates.push(['avatar_illustration_image_id', null])
      } else if (typeof raw === 'string' && raw) {
        updates.push(['avatar_illustration_image_id', raw])
      } else {
        return validationError('avatarIllustrationImageId must be a non-empty string or null.')
      }
    }

    let odometerChanged = false
    if (body.odometerCurrent != null) {
      // Staff going backwards must supply a `correctionReason`. The bump
      // helper rewrites the source to `staff-correction` when it lands, so
      // the history tab can render it distinctly. Missing reason on a
      // downward write → 422 (correction_reason_required).
      const correctionReason = typeof body.correctionReason === 'string' ? body.correctionReason : null
      const bump = await bumpOdometer(db, Number(vehicleId), Number(body.odometerCurrent), 'staff-patch', {
        actorType:        'staff',
        actorId:          Number(ctx.staffId) || null,
        allowBackwards:   true,
        correctionReason,
      })
      if (!bump.ok && bump.reason === 'backwards') {
        return validationError(`odometerCurrent cannot decrease. Previous reading was ${bump.previous.toLocaleString()} km.`)
      }
      if (!bump.ok && bump.reason === 'correction_reason_required') {
        return validationError(`odometerCurrent is going backwards (from ${bump.previous.toLocaleString()} to ${bump.attempted.toLocaleString()} km) — please include a correctionReason explaining why.`)
      }
      if (!bump.ok && bump.reason === 'not_found') return notFound('Vehicle')
      odometerChanged = bump.ok
    }

    if (updates.length === 0 && !settingsPatch && !odometerChanged) {
      return validationError('No valid fields to update.')
    }

    if (updates.length > 0) {
      const set    = updates.map(([k]) => `${k} = ?`).join(', ')
      const values = [...updates.map(([, v]) => v), vehicleId]
      await db.query(`UPDATE vehicles SET ${set}, updated_at = NOW() WHERE id = ?`, values)
    }

    if (settingsPatch) {
      await mergePublicProfileSettings(db, Number(vehicleId), settingsPatch)
    }

    // Fire-and-forget: delete the replaced Cloudflare images. Log but don't
    // surface failures — cache-purge-style side effect.
    if (previousAvatarId && previousAvatarId !== body.avatarImageId) {
      deleteCloudflareImage(previousAvatarId).catch(err =>
        console.error(`Failed to delete previous avatar ${previousAvatarId}:`, err),
      )
    }
    if (previousCoverId && previousCoverId !== body.coverImageId) {
      deleteCloudflareImage(previousCoverId).catch(err =>
        console.error(`Failed to delete previous cover ${previousCoverId}:`, err),
      )
    }

    if (body.odometerCurrent != null) {
      void maybeRegenerateSchedule(db, Number(vehicleId), Number(body.odometerCurrent), Number(customerId))
    }

    await safeDel([`vehicle:${vehicleId}:context`, `customer:${customerId}:profile`])

    const load = await loadVehicleForResponse(db, customerId!, vehicleId!)
    if (load.state !== 'ok') return serverError(new Error('Vehicle disappeared after update'))

    return ok({ vehicle: load.payload })
  } catch (err) {
    return serverError(err)
  }
}
