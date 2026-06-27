import mysql from 'mysql2/promise'
import { getAllowedStoreIds } from '../jobs/_helpers'

export type RollingPeriod = '7d' | '30d' | '3m'

// Melbourne today as YYYY-MM-DD
function melbToday(): string {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function rollingRange(period: RollingPeriod): { from: string; to: string } {
  const today = new Date(melbToday())
  const from  = new Date(today)

  if (period === '7d')  from.setDate(today.getDate() - 7)
  else if (period === '30d') from.setDate(today.getDate() - 30)
  else {
    // 3 calendar months back
    from.setMonth(today.getMonth() - 3)
  }

  return {
    from: from.toISOString().slice(0, 10),
    to:   today.toISOString().slice(0, 10),
  }
}

// Count Mon–Sat working days in [from, to] inclusive
export function countWorkingDaysMtoS(fromStr: string, toStr: string): number {
  let count = 0
  const cur = new Date(fromStr)
  const end = new Date(toStr)
  while (cur <= end) {
    const d = cur.getUTCDay()
    if (d !== 0) count++ // exclude Sunday only
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return Math.max(count, 1)
}

export interface StoreScope {
  ids: number[]        // empty = no access
  label: string        // "Somerville" | "all"
  isAll: boolean
}

// Resolves which store IDs a caller can see, and a display label.
// For non-super_admin, ignores storeParam entirely.
export async function resolveStoreScope(
  db: mysql.Pool,
  role: string,
  staffId: string,
  storeId: number,
  storeParam: string | undefined,
): Promise<StoreScope> {
  if (role !== 'super_admin') {
    const allowedIds = await getAllowedStoreIds(db, staffId)
    // Fall back to JWT storeId if staff_store_access is empty
    const ids = allowedIds.length > 0 ? allowedIds : (storeId ? [storeId] : [])
    const [[storeRow]] = await db.query<any[]>(
      'SELECT name FROM stores WHERE id = ? LIMIT 1',
      [ids[0]],
    )
    return { ids, label: (storeRow?.name ?? '').replace(/^Rodz /, ''), isAll: false }
  }

  // super_admin
  if (!storeParam || storeParam === 'all') {
    const [rows] = await db.query<any[]>('SELECT id FROM stores WHERE is_active = 1')
    return { ids: rows.map((r: any) => Number(r.id)), label: 'all', isAll: true }
  }

  const [[storeRow]] = await db.query<any[]>(
    'SELECT id, name FROM stores WHERE name LIKE ? AND is_active = 1 LIMIT 1',
    [`%${storeParam}%`],
  )
  if (!storeRow) return { ids: [], label: storeParam, isAll: false }
  return { ids: [Number(storeRow.id)], label: storeRow.name.replace(/^Rodz /, ''), isAll: false }
}

export function storeWhere(ids: number[]): { clause: string; params: number[] } {
  return {
    clause: `store_id IN (${ids.map(() => '?').join(',')})`,
    params: ids,
  }
}

export function pct(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}
