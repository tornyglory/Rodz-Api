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
