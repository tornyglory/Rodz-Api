import mysql from 'mysql2/promise'
import { imageUrls } from '../../../shared/cloudflare'

export const POLICY_TYPES = ['registration', 'wof', 'insurance', 'roadside'] as const
export type PolicyType = (typeof POLICY_TYPES)[number]

export function isPolicyType(v: unknown): v is PolicyType {
  return typeof v === 'string' && (POLICY_TYPES as readonly string[]).includes(v)
}

// Ownership guard shared by every policies handler. Returns true if the
// caller currently owns the vehicle; false otherwise. Matches the pattern
// used elsewhere in `src/customer/vehicles/*`.
export async function customerOwnsVehicle(
  db: mysql.Pool,
  vehicleId: number,
  customerId: number,
): Promise<boolean> {
  const [[row]] = await db.query<any[]>(
    'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
    [vehicleId, customerId],
  )
  return !!row
}

// ISO date coercion. MySQL DATE columns come back as JS Date objects (or
// strings depending on driver flags) — normalise both to `YYYY-MM-DD`.
function toIsoDate(v: any): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  const d = new Date(s.includes('T') ? s : `${s}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function toIsoDateTime(v: any): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export function buildPolicyResponse(row: any): Record<string, unknown> {
  return {
    id:             Number(row.id),
    type:           row.type as PolicyType,
    provider:       row.provider      ?? null,
    policyNumber:   row.policy_number ?? null,
    costAud:        row.cost_aud != null ? Number(row.cost_aud) : null,
    effectiveFrom:  toIsoDate(row.effective_from),
    expiresOn:      toIsoDate(row.expires_on),
    phone:          row.phone ?? null,
    notes:          row.notes ?? null,
    imageId:        row.image_id ?? null,
    imageUrl:       row.image_id ? imageUrls(row.image_id).public : null,
    updatedAt:      toIsoDateTime(row.updated_at) ?? new Date().toISOString(),
  }
}

// Coerce + validate a partial patch. Returns a { columns, values } tuple
// ready for `SET ${columns.join(', ')} = ?` shaped SQL. Null values are
// allowed (explicit "clear this field") for every column except type
// (immutable — the frontend must delete + recreate to change).
//
// Throws string error message on validation failure — caller returns 422.
export function coercePolicyPatch(body: Record<string, unknown>): {
  columns: string[]
  values:  unknown[]
} {
  const columns: string[] = []
  const values:  unknown[] = []

  const push = (col: string, val: unknown) => { columns.push(col); values.push(val) }

  if ('provider' in body) {
    if (body.provider !== null && typeof body.provider !== 'string') throw 'provider must be a string or null.'
    push('provider', body.provider === null ? null : String(body.provider).trim().slice(0, 200))
  }
  if ('policyNumber' in body) {
    if (body.policyNumber !== null && typeof body.policyNumber !== 'string') throw 'policyNumber must be a string or null.'
    push('policy_number', body.policyNumber === null ? null : String(body.policyNumber).trim().slice(0, 120))
  }
  if ('costAud' in body) {
    if (body.costAud !== null) {
      const n = Number(body.costAud)
      if (!Number.isFinite(n) || n < 0) throw 'costAud must be a non-negative number or null.'
      push('cost_aud', n)
    } else {
      push('cost_aud', null)
    }
  }
  if ('effectiveFrom' in body) {
    if (body.effectiveFrom !== null && !isYyyyMmDd(body.effectiveFrom)) throw "effectiveFrom must be 'YYYY-MM-DD' or null."
    push('effective_from', body.effectiveFrom)
  }
  if ('expiresOn' in body) {
    if (body.expiresOn !== null && !isYyyyMmDd(body.expiresOn)) throw "expiresOn must be 'YYYY-MM-DD' or null."
    push('expires_on', body.expiresOn)
  }
  if ('phone' in body) {
    if (body.phone !== null && typeof body.phone !== 'string') throw 'phone must be a string or null.'
    push('phone', body.phone === null ? null : String(body.phone).trim().slice(0, 40))
  }
  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') throw 'notes must be a string or null.'
    push('notes', body.notes === null ? null : String(body.notes))
  }
  if ('imageId' in body) {
    if (body.imageId !== null && typeof body.imageId !== 'string') throw 'imageId must be a string or null.'
    push('image_id', body.imageId === null ? null : String(body.imageId).trim().slice(0, 80))
  }

  return { columns, values }
}

function isYyyyMmDd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}
