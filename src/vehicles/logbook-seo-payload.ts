import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { notFound, gone, serverError } from '../shared/errors'
import { imageUrls } from '../shared/cloudflare'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import { loadProfileForVehicle } from '../shared/vehicleProfile'
import { safeGet, safeSetEx } from '../shared/redis'

const ready = bootstrap()

const CACHE_TTL_SEC = 300
const HTTP_CACHE = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'

type MinimalPayload = {
  searchIndex: false
  vehicle: {
    rego: string
    regoState: string | null
    year: number
    make: string
    model: string
  }
  lastMutation: string
}

type FullPayload = {
  searchIndex: true
  lastMutation: string
  vehicle: Record<string, unknown>
  publicProfileSettings: ReturnType<typeof parsePublicProfileSettings>
  description: string | null
  ownerDescription: string | null
  aiOverview: {
    source: 'override' | 'base' | null
    tone:   string | null
    text:   string | null
  }
  ownerCard?: {
    displayName: string
    city:        string | null
    avatarUrl:   string | null
    memberSince: string
  }
  gallery?:               Array<{ url: string; alt: string | null }>
  serviceHistoryPreview?: {
    totalCount: number
    entries: Array<Record<string, unknown>>
  }
  modificationsPreview?: {
    totalCount:    number
    totalInvested: number
    items: Array<Record<string, unknown>>
  }
  storiesPreview?: {
    totalCount: number
    items: Array<Record<string, unknown>>
  }
}

const jsonResponse = (
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body),
})

const toIso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const t = d instanceof Date ? d : new Date(d)
  return isNaN(t.getTime()) ? null : t.toISOString()
}

const latest = (...dates: Array<Date | string | null | undefined>): string => {
  let max = 0
  for (const d of dates) {
    if (!d) continue
    const t = (d instanceof Date ? d : new Date(d)).getTime()
    if (!isNaN(t) && t > max) max = t
  }
  return new Date(max || Date.now()).toISOString()
}

const engineSizeDisplay = (cc: number | null): string | null =>
  cc ? `${(Number(cc) / 1000).toFixed(1)}L` : null

// Base overview is the shared per-(make, model, year) narrative — the same
// prose across every vehicle of that model. Emitting it as body copy on
// thousands of pages is the canonical duplicate-content SEO trap. Only the
// per-vehicle override (owner-authored + tone-varied) may surface as prose.
export function shapeAiOverview(
  base:     { overview?: string | null } | null | undefined,
  override: { overview?: string | null; tone?: string | null } | null | undefined,
): FullPayload['aiOverview'] {
  if (override?.overview) {
    return { source: 'override', tone: override.tone ?? null, text: override.overview }
  }
  if (base?.overview) {
    return { source: 'base', tone: null, text: null }
  }
  return { source: null, tone: null, text: null }
}

const dateStr = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  if (!token) return notFound('Vehicle')

  try {
    const cacheKey = `seo:${token}`
    const cached = await safeGet<{ payload: MinimalPayload | FullPayload; lastMutation: string }>(cacheKey)

    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.rego_state, v.year, v.make, v.model, v.series, v.colour,
              v.body_type, v.fuel_type, v.transmission, v.drive_type,
              v.engine_code, v.engine_size_cc, v.cylinders,
              v.odometer_current, v.vin,
              v.avatar_image_id, v.cover_image_id,
              v.city, v.country,
              v.for_sale, v.asking_price,
              v.description, v.logbook_token,
              v.public_profile_settings, v.is_active, v.updated_at
       FROM vehicles v
       WHERE v.logbook_token = ?
       LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const settings = parsePublicProfileSettings(vehicle.public_profile_settings)

    const vehicleCore = {
      rego:          vehicle.rego,
      regoState:     vehicle.rego_state ?? null,
      year:          vehicle.year,
      make:          vehicle.make,
      model:         vehicle.model,
    }

    // ── searchIndex=false → minimal payload ─────────────────────────────
    if (!settings.searchIndex) {
      const minimal: MinimalPayload = {
        searchIndex:  false,
        vehicle:      vehicleCore,
        lastMutation: latest(vehicle.updated_at),
      }
      return jsonResponse(200, minimal, { 'Cache-Control': HTTP_CACHE })
    }

    // Serve from cache if the vehicle hasn't mutated since we cached it.
    if (cached && cached.lastMutation === latest(vehicle.updated_at) && cached.payload.searchIndex) {
      return jsonResponse(200, cached.payload, { 'Cache-Control': HTTP_CACHE })
    }

    // ── Owner (for ownerCard + ownerDescription) ────────────────────────
    const [[owner]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.suburb, c.avatar_image_id,
              c.description AS owner_description, c.created_at AS member_since
       FROM vehicle_owners vo
       JOIN customers c ON c.id = vo.customer_id
       WHERE vo.vehicle_id = ? AND vo.is_current = 1
       LIMIT 1`,
      [vehicle.id],
    )

    // ── AI overview (base vs override — duplicate-content policy) ───────
    const { base, override } = await loadProfileForVehicle(db, {
      id:    vehicle.id,
      make:  vehicle.make,
      model: vehicle.model,
      year:  vehicle.year,
    })
    const aiOverview = shapeAiOverview(base, override)
    const overrideTs = override?.regenerated_at ?? null
    const baseTs     = base?.generated_at ?? null

    // ── Gallery ─────────────────────────────────────────────────────────
    let gallery: FullPayload['gallery'] | undefined
    let galleryLatest: Date | null = null
    if (settings.photos) {
      const [galleryRows] = await db.query<any[]>(
        `SELECT image_id, sort_order, created_at
         FROM vehicle_gallery_images
         WHERE vehicle_id = ? AND deleted_at IS NULL
         ORDER BY sort_order ASC, id ASC
         LIMIT 20`,
        [vehicle.id],
      )
      gallery = galleryRows.map((r: any) => ({
        url: imageUrls(r.image_id).public,
        alt: null,
      }))
      for (const r of galleryRows) {
        const t = r.created_at instanceof Date ? r.created_at : new Date(r.created_at)
        if (!galleryLatest || t > galleryLatest) galleryLatest = t
      }
    }

    // ── Service history preview ─────────────────────────────────────────
    let serviceHistoryPreview: FullPayload['serviceHistoryPreview'] | undefined
    let historyLatest: Date | null = null
    if (settings.history) {
      const [historyRows] = await db.query<any[]>(
        `SELECT id, service_date, odometer, workshop_name, service_summary, total_charged
         FROM vehicle_service_history
         WHERE vehicle_id = ?
         ORDER BY service_date DESC, id DESC
         LIMIT 10`,
        [vehicle.id],
      )
      const [[historyCount]] = await db.query<any[]>(
        `SELECT COUNT(*) AS n FROM vehicle_service_history WHERE vehicle_id = ?`,
        [vehicle.id],
      )
      serviceHistoryPreview = {
        totalCount: Number(historyCount?.n ?? 0),
        entries: historyRows.map((r: any) => ({
          id:             String(r.id),
          date:           dateStr(r.service_date),
          odometerKm:     r.odometer != null ? Number(r.odometer) : null,
          title:          r.service_summary ?? null,
          workshop:       r.workshop_name ?? null,
          workshopSuburb: null,
          cost:           r.total_charged != null ? Number(r.total_charged) : null,
          source:         r.service_job_id ? 'workshop' : 'external',
        })),
      }
      // vehicle_service_history has no updated_at column; use service_date as an approximation.
      for (const r of historyRows) {
        const t = new Date(r.service_date)
        if (!historyLatest || t > historyLatest) historyLatest = t
      }
    }

    // ── Modifications preview ───────────────────────────────────────────
    let modificationsPreview: FullPayload['modificationsPreview'] | undefined
    let modsLatest: Date | null = null
    if (settings.modifications) {
      const [modRows] = await db.query<any[]>(
        `SELECT id, name, category, installed_at, status, cover_image_id, updated_at
         FROM vehicle_modifications
         WHERE vehicle_id = ? AND deleted_at IS NULL AND is_public = 1
         ORDER BY COALESCE(cost_aud, 0) DESC, id DESC
         LIMIT 5`,
        [vehicle.id],
      )
      const [[modAgg]] = await db.query<any[]>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_aud), 0) AS total
         FROM vehicle_modifications
         WHERE vehicle_id = ? AND deleted_at IS NULL AND is_public = 1`,
        [vehicle.id],
      )
      modificationsPreview = {
        totalCount:    Number(modAgg?.n ?? 0),
        totalInvested: Number(modAgg?.total ?? 0),
        items: modRows.map((r: any) => ({
          id:          Number(r.id),
          name:        r.name,
          category:    r.category,
          installedAt: dateStr(r.installed_at),
          status:      r.status,
          thumbUrl:    r.cover_image_id ? imageUrls(r.cover_image_id).thumbnail : null,
        })),
      }
      for (const r of modRows) {
        const t = r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)
        if (!modsLatest || t > modsLatest) modsLatest = t
      }
    }

    // ── Stories preview ─────────────────────────────────────────────────
    let storiesPreview: FullPayload['storiesPreview'] | undefined
    let storiesLatest: Date | null = null
    if (settings.stories) {
      const [storyRows] = await db.query<any[]>(
        `SELECT s.id, s.title, s.description, s.event_date, s.updated_at,
                (SELECT cf_image_id FROM story_media
                  WHERE story_id = s.id AND media_type = 'image' AND deleted_at IS NULL
                  ORDER BY sort_order ASC, id ASC LIMIT 1) AS cover_image_id,
                EXISTS (SELECT 1 FROM story_media
                  WHERE story_id = s.id AND media_type = 'video' AND deleted_at IS NULL) AS has_video,
                (SELECT COUNT(*) FROM story_reactions WHERE story_id = s.id) AS reactions_count
         FROM stories s
         WHERE s.vehicle_id = ? AND s.deleted_at IS NULL
           AND s.status = 'published' AND s.is_public = 1
         ORDER BY s.event_date DESC, s.id DESC
         LIMIT 3`,
        [vehicle.id],
      )
      const [[storyCount]] = await db.query<any[]>(
        `SELECT COUNT(*) AS n FROM stories
         WHERE vehicle_id = ? AND deleted_at IS NULL
           AND status = 'published' AND is_public = 1`,
        [vehicle.id],
      )
      storiesPreview = {
        totalCount: Number(storyCount?.n ?? 0),
        items: storyRows.map((r: any) => ({
          id:             `s-${r.id}`,
          title:          r.title,
          preview:        r.description ? String(r.description).slice(0, 200) : null,
          eventDate:      dateStr(r.event_date),
          coverUrl:       r.cover_image_id ? imageUrls(r.cover_image_id).public : null,
          hasVideo:       !!Number(r.has_video),
          reactionsCount: Number(r.reactions_count ?? 0),
        })),
      }
      for (const r of storyRows) {
        const t = r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)
        if (!storiesLatest || t > storiesLatest) storiesLatest = t
      }
    }

    // ── Owner card (uses chat toggle as v1 proxy per the brief) ─────────
    let ownerCard: FullPayload['ownerCard']
    if (settings.chat && owner?.first_name) {
      const lastInitial = owner.last_name ? `${String(owner.last_name).charAt(0).toUpperCase()}.` : ''
      ownerCard = {
        displayName: lastInitial ? `${owner.first_name} ${lastInitial}` : owner.first_name,
        city:        owner.suburb ?? null,
        avatarUrl:   owner.avatar_image_id ? imageUrls(owner.avatar_image_id).public : null,
        memberSince: owner.member_since instanceof Date
          ? `${owner.member_since.getUTCFullYear()}-${String(owner.member_since.getUTCMonth() + 1).padStart(2, '0')}`
          : String(owner.member_since ?? '').slice(0, 7),
      }
    }

    const payload: FullPayload = {
      searchIndex:  true,
      lastMutation: latest(
        vehicle.updated_at,
        overrideTs,
        baseTs,
        galleryLatest,
        historyLatest,
        modsLatest,
        storiesLatest,
      ),
      vehicle: {
        rego:          vehicle.rego,
        regoState:     vehicle.rego_state ?? null,
        year:          vehicle.year,
        make:          vehicle.make,
        model:         vehicle.model,
        series:        vehicle.series      ?? null,
        colour:        vehicle.colour      ?? null,
        bodyType:      vehicle.body_type   ?? null,
        fuelType:      vehicle.fuel_type   ?? null,
        transmission:  vehicle.transmission ?? null,
        driveType:     vehicle.drive_type  ?? null,
        engineCode:    vehicle.engine_code ?? null,
        engineSizeCC:  vehicle.engine_size_cc != null ? Number(vehicle.engine_size_cc) : null,
        engineSize:    engineSizeDisplay(vehicle.engine_size_cc),
        cylinders:     vehicle.cylinders   != null ? Number(vehicle.cylinders) : null,
        odometerKm:    vehicle.odometer_current != null ? Number(vehicle.odometer_current) : null,
        vin:           vehicle.vin ?? null,
        avatarUrl:     vehicle.avatar_image_id ? imageUrls(vehicle.avatar_image_id).public : null,
        coverUrl:      vehicle.cover_image_id  ? imageUrls(vehicle.cover_image_id).public  : null,
        city:          vehicle.city    ?? null,
        country:       vehicle.country ?? null,
        forSale:       !!vehicle.for_sale,
        askingPrice:   vehicle.asking_price != null ? Number(vehicle.asking_price) : null,
        logbookToken:  vehicle.logbook_token,
      },
      publicProfileSettings: settings,
      description:      vehicle.description ?? null,
      ownerDescription: owner?.owner_description ?? null,
      aiOverview,
      ...(ownerCard ? { ownerCard } : {}),
      ...(gallery              ? { gallery              } : {}),
      ...(serviceHistoryPreview ? { serviceHistoryPreview } : {}),
      ...(modificationsPreview ? { modificationsPreview } : {}),
      ...(storiesPreview       ? { storiesPreview       } : {}),
    }

    await safeSetEx(cacheKey, CACHE_TTL_SEC, { payload, lastMutation: payload.lastMutation })

    return jsonResponse(200, payload, { 'Cache-Control': HTTP_CACHE })
  } catch (err) {
    return serverError(err)
  }
}
