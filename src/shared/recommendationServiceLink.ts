import type mysql from 'mysql2/promise'

// Shared helper for the four recommendation read paths (staff, customer,
// public logbook, health digest). Given a set of service_type_ids drawn
// from `ai_recommendations.service_type_id`, load the display fields the
// frontend needs to render a "Book: <service>" affordance without a
// second round-trip.

export interface ServiceLink {
  id:                    number
  name:                  string
  category:              string
  labourHoursEstimate:   number
  fixedPrice:            number | null
}

// Fetches every referenced service_type in one query and returns a Map
// keyed by id. Silently drops ids that reference deactivated services —
// the caller renders those recommendations without a `service` block,
// same as a null service_type_id.
export async function loadServiceLinks(
  db: mysql.Pool,
  serviceTypeIds: Array<number | null | undefined>,
): Promise<Map<number, ServiceLink>> {
  const ids = Array.from(new Set(
    serviceTypeIds
      .map(v => (v != null ? Number(v) : null))
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 0),
  ))
  if (ids.length === 0) return new Map()

  const [rows] = await db.query<any[]>(
    `SELECT id, name, category, labour_hours_estimate, fixed_price
     FROM service_types
     WHERE id IN (${ids.map(() => '?').join(',')})
       AND is_active = 1 AND is_bookable = 1`,
    ids,
  )

  const map = new Map<number, ServiceLink>()
  for (const r of rows) {
    map.set(Number(r.id), {
      id:                  Number(r.id),
      name:                String(r.name),
      category:            String(r.category),
      labourHoursEstimate: Number(r.labour_hours_estimate),
      fixedPrice:          r.fixed_price != null ? Number(r.fixed_price) : null,
    })
  }
  return map
}

// Shape helper — returns the object to nest as `service` on a
// recommendation payload, or null when there's no live service link.
export function shapeService(
  serviceTypeId: number | null | undefined,
  linkMap: Map<number, ServiceLink>,
): ServiceLink | null {
  if (serviceTypeId == null) return null
  const link = linkMap.get(Number(serviceTypeId))
  return link ?? null
}

// ─── Part names for the "typical parts" block on the recommendation card

export interface PartLink {
  id:       number
  name:     string
  category: string
  spec:     string   // LLM-picked vehicle-specific hint (grade/size/OEM ref); '' when generic
}

// ai_recommendations.parts is stored as JSON [{id, spec}, ...].
// mysql2 returns a JSON column as either a parsed value or a string
// depending on version/config — normalise either into the object array.
// Anything malformed becomes [].
export function parseParts(raw: unknown): Array<{ id: number; spec: string }> {
  if (raw == null) return []
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  const out: Array<{ id: number; spec: string }> = []
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const id = Number((item as any).id)
      if (!Number.isFinite(id) || id <= 0) continue
      const spec = typeof (item as any).spec === 'string' ? (item as any).spec : ''
      out.push({ id, spec })
    }
  }
  return out
}

// One IN() query for the union of part_name ids across every
// recommendation on the page. Deactivated rows are silently dropped so
// the frontend renders a shorter list rather than showing something
// the workshop no longer stocks.
export async function loadPartLinks(
  db: mysql.Pool,
  partBundles: Array<Array<{ id: number; spec: string }>>,
): Promise<Map<number, { name: string; category: string }>> {
  const ids = Array.from(new Set(
    partBundles.flat().map(p => p.id).filter(n => Number.isFinite(n) && n > 0),
  ))
  if (ids.length === 0) return new Map()

  const [rows] = await db.query<any[]>(
    `SELECT id, name, category
     FROM part_names
     WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active = 1`,
    ids,
  )
  const map = new Map<number, { name: string; category: string }>()
  for (const r of rows) {
    map.set(Number(r.id), {
      name:     String(r.name),
      category: String(r.category ?? 'Other'),
    })
  }
  return map
}

// Shape helper — merges the stored {id, spec} with the joined
// {name, category} from part_names for the response payload. Preserves
// the LLM's chosen order and drops any id that isn't in the live
// catalogue.
export function shapeParts(
  parts: Array<{ id: number; spec: string }>,
  linkMap: Map<number, { name: string; category: string }>,
): PartLink[] {
  const out: PartLink[] = []
  for (const p of parts) {
    const link = linkMap.get(Number(p.id))
    if (!link) continue
    out.push({
      id:       p.id,
      name:     link.name,
      category: link.category,
      spec:     p.spec,
    })
  }
  return out
}
