import mysql from 'mysql2/promise'
import { imageUrls } from '../../../shared/cloudflare'

export const MOD_CATEGORIES = [
  'engine', 'forced_induction', 'exhaust', 'intake', 'fuel_system',
  'ecu_tune', 'ignition', 'cooling', 'transmission', 'suspension',
  'brakes', 'wheels_tyres', 'interior', 'exterior', 'audio',
  'electronics', 'other',
] as const
export type ModCategory = (typeof MOD_CATEGORIES)[number]

export const MOD_STATUSES = ['installed', 'removed', 'planned'] as const
export type ModStatus = (typeof MOD_STATUSES)[number]

// Same guard used across /c/vehicles/{id}/*
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

export interface ModificationMedia {
  id:            number
  kind:          'photo' | 'receipt'
  imageId:       string
  imageUrl:      string
  imageThumbUrl: string
  caption:       string | null
  sortOrder:     number
  amountAud:     number | null
  supplier:      string | null
  purchasedAt:   string | null
  expenseEventId: number | null
  createdAt:     string
}

export function shapeMedia(row: any): ModificationMedia {
  const urls = imageUrls(row.image_id)
  return {
    id:             Number(row.id),
    kind:           row.kind,
    imageId:        String(row.image_id),
    imageUrl:       urls.public,
    imageThumbUrl:  urls.thumbnail,
    caption:        row.caption ?? null,
    sortOrder:      Number(row.sort_order ?? 0),
    amountAud:      row.amount_aud != null ? Number(row.amount_aud) : null,
    supplier:       row.supplier ?? null,
    purchasedAt:    toIsoDate(row.purchased_at),
    expenseEventId: row.expense_event_id != null ? Number(row.expense_event_id) : null,
    createdAt:      toIsoDateTime(row.created_at) ?? new Date().toISOString(),
  }
}

export function shapeModification(row: any, media: ModificationMedia[] = []): Record<string, unknown> {
  const coverUrls = row.cover_image_id ? imageUrls(row.cover_image_id) : null
  const receipts = media.filter(m => m.kind === 'receipt')
  const totalReceiptSpend = receipts.reduce((sum, r) => sum + (r.amountAud ?? 0), 0)
  return {
    id:                Number(row.id),
    vehicleId:         Number(row.vehicle_id),
    category:          row.category as ModCategory,
    name:              String(row.name),
    brand:             row.brand ?? null,
    description:       row.description ?? null,
    installedAt:       toIsoDate(row.installed_at),
    installedBy:       row.installed_by ?? null,
    costAud:           row.cost_aud != null ? Number(row.cost_aud) : null,
    status:            row.status as ModStatus,
    removedAt:         toIsoDate(row.removed_at),
    keptWithSale:      Number(row.kept_with_sale) === 1,
    isPublic:          Number(row.is_public) === 1,
    coverImageId:      row.cover_image_id ?? null,
    coverUrl:          coverUrls?.public ?? null,
    coverThumbUrl:     coverUrls?.thumbnail ?? null,
    createdAt:         toIsoDateTime(row.created_at) ?? new Date().toISOString(),
    updatedAt:         toIsoDateTime(row.updated_at) ?? new Date().toISOString(),
    media,
    receiptCount:      receipts.length,
    totalReceiptSpend: totalReceiptSpend > 0 ? totalReceiptSpend : null,
  }
}

// Coerce + validate a patch body. Returns { columns, values } tuple for
// dynamic UPDATE SET. Throws string error on validation failure.
export function coerceModPatch(body: Record<string, unknown>): {
  columns: string[]
  values:  unknown[]
} {
  const columns: string[] = []
  const values:  unknown[] = []
  const push = (col: string, val: unknown) => { columns.push(col); values.push(val) }

  if ('category' in body) {
    if (!body.category || !(MOD_CATEGORIES as readonly string[]).includes(String(body.category))) {
      throw `category must be one of: ${MOD_CATEGORIES.join(', ')}.`
    }
    push('category', String(body.category))
  }
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw 'name is required.'
    push('name', String(body.name).trim().slice(0, 200))
  }
  if ('brand' in body) {
    if (body.brand !== null && typeof body.brand !== 'string') throw 'brand must be a string or null.'
    push('brand', body.brand === null ? null : String(body.brand).trim().slice(0, 100) || null)
  }
  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') throw 'description must be a string or null.'
    push('description', body.description === null ? null : String(body.description).trim() || null)
  }
  if ('installedAt' in body) {
    if (body.installedAt !== null && !isYyyyMmDd(body.installedAt)) throw "installedAt must be 'YYYY-MM-DD' or null."
    push('installed_at', body.installedAt)
  }
  if ('installedBy' in body) {
    if (body.installedBy !== null && typeof body.installedBy !== 'string') throw 'installedBy must be a string or null.'
    push('installed_by', body.installedBy === null ? null : String(body.installedBy).trim().slice(0, 200) || null)
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
  if ('status' in body) {
    if (!(MOD_STATUSES as readonly string[]).includes(String(body.status))) {
      throw `status must be one of: ${MOD_STATUSES.join(', ')}.`
    }
    push('status', String(body.status))
  }
  if ('removedAt' in body) {
    if (body.removedAt !== null && !isYyyyMmDd(body.removedAt)) throw "removedAt must be 'YYYY-MM-DD' or null."
    push('removed_at', body.removedAt)
  }
  if ('keptWithSale' in body) {
    push('kept_with_sale', body.keptWithSale ? 1 : 0)
  }
  if ('isPublic' in body) {
    push('is_public', body.isPublic ? 1 : 0)
  }
  if ('coverImageId' in body) {
    if (body.coverImageId !== null && typeof body.coverImageId !== 'string') throw 'coverImageId must be a string or null.'
    push('cover_image_id', body.coverImageId === null ? null : String(body.coverImageId).trim().slice(0, 80) || null)
  }

  return { columns, values }
}

function isYyyyMmDd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

export async function loadMediaForMod(db: mysql.Pool, modId: number): Promise<ModificationMedia[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, kind, image_id, caption, sort_order, amount_aud, supplier, purchased_at,
            expense_event_id, created_at
     FROM vehicle_modification_media
     WHERE modification_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [modId],
  )
  return rows.map(shapeMedia)
}
