import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import type { AuthContext } from '../../shared/types'
import type { Pool } from 'mysql2/promise'
import { forbidden } from '../../shared/errors'

// Staff scope guard for booking-slot mutations. super_admin can touch any
// store; manager only their own store; technician blocked entirely.
export async function guardStaffStoreAccess(
  db: Pool,
  ctx: AuthContext,
  targetStoreId: number,
): Promise<APIGatewayProxyResultV2 | null> {
  if (ctx.role === 'technician') return forbidden()
  if (ctx.role === 'super_admin') return null
  // store_manager — only their own store
  if (Number(ctx.storeId) === Number(targetStoreId)) return null
  return forbidden()
}

function timeToHHMM(v: any): string {
  const s = v instanceof Date ? v.toISOString().slice(11, 19) : String(v).slice(0, 8)
  return s.slice(0, 5)
}

export function shapeSlotResponse(row: any) {
  return {
    id:        Number(row.id),
    storeId:   Number(row.store_id),
    time:      timeToHHMM(row.slot_time),
    endTime:   timeToHHMM(row.end_time),
    label:     row.label ?? null,
    sortOrder: Number(row.sort_order),
    isActive:  Number(row.is_active) === 1,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

// Parse a client-supplied HH:MM to a validated 'HH:MM:SS' or return null.
export function parseTime(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!/^\d{2}:\d{2}$/.test(t)) return null
  const [hh, mm] = t.split(':').map(Number)
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return `${t}:00`
}
