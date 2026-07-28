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

export function shapeSlotResponse(row: any) {
  const t = row.slot_time instanceof Date
    ? row.slot_time.toISOString().slice(11, 19)
    : String(row.slot_time).slice(0, 8)
  return {
    id:        Number(row.id),
    storeId:   Number(row.store_id),
    time:      t.slice(0, 5),
    label:     row.label ?? null,
    sortOrder: Number(row.sort_order),
    isActive:  Number(row.is_active) === 1,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}
