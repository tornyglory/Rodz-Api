import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

// ── In-memory cache (5 min TTL) ────────────────────────────────────────────
const cache = new Map<string, { data: any; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCached(key: string): any | null {
  const entry = cache.get(key)
  if (entry && entry.expiresAt > Date.now()) return entry.data
  return null
}
function setCached(key: string, data: any): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ── Types ───────────────────────────────────────────────────────────────────
type Period = 'week' | 'month' | 'year'

// ── Date helpers (Melbourne local time) ────────────────────────────────────
function melbNow(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const v = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  return new Date(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'))
}

function periodRange(period: Period): { start: Date; end: Date } {
  const now = melbNow()
  if (period === 'week') {
    const day = now.getDay()                        // 0=Sun
    const daysToMon = day === 0 ? -6 : 1 - day
    const mon = new Date(now)
    mon.setDate(now.getDate() + daysToMon)
    mon.setHours(0, 0, 0, 0)
    const nextMon = new Date(mon)
    nextMon.setDate(mon.getDate() + 7)
    return { start: mon, end: nextMon }
  }
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end   = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return { start, end }
  }
  const start = new Date(now.getFullYear(), 0, 1)
  const end   = new Date(now.getFullYear() + 1, 0, 1)
  return { start, end }
}

function periodLabels(period: Period, start: Date): string[] {
  if (period === 'week')  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  if (period === 'month') {
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
    return Array.from({ length: days }, (_, i) => String(i + 1))
  }
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
}

// Map a display label back to the MySQL DAYOFWEEK / DAY / MONTH bucket key
function labelToKey(period: Period, label: string): string {
  if (period === 'week') {
    // DAYOFWEEK: 1=Sun, 2=Mon ... 7=Sat
    const keys = ['2', '3', '4', '5', '6', '7', '1']
    return keys[['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(label)]
  }
  if (period === 'month') return label  // day number
  // year — month number
  return String(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(label) + 1)
}

// ── SQL query per store ─────────────────────────────────────────────────────
function toSqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

async function queryStore(
  db: mysql.Pool,
  storeId: number,
  period: Period,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const bucketExpr =
    period === 'week'  ? `DAYOFWEEK(CONVERT_TZ(i.paid_at, '+00:00', 'Australia/Melbourne'))` :
    period === 'month' ? `DAY(CONVERT_TZ(i.paid_at, '+00:00', 'Australia/Melbourne'))` :
                         `MONTH(CONVERT_TZ(i.paid_at, '+00:00', 'Australia/Melbourne'))`

  const [rows] = await db.query<any[]>(
    `SELECT ${bucketExpr} AS k, SUM(i.total) AS rev
     FROM invoices i
     WHERE i.store_id = ? AND i.status = 'paid'
       AND i.paid_at >= ? AND i.paid_at < ?
     GROUP BY k`,
    [storeId, toSqlTs(start), toSqlTs(end)],
  )

  const map = new Map<string, number>()
  for (const row of rows) map.set(String(row.k), Number(row.rev))
  return map
}

// ── Build values + summary ──────────────────────────────────────────────────
function buildValues(labels: string[], revenueMap: Map<string, number>, period: Period): number[] {
  return labels.map(label => Math.round((revenueMap.get(labelToKey(period, label)) ?? 0) * 100) / 100)
}

function buildSummary(labels: string[], values: number[]) {
  const total    = Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100
  const peak     = values.length ? Math.max(...values) : 0
  const peakIdx  = values.indexOf(peak)
  return {
    total,
    average:   Math.round(total / (labels.length || 1) * 100) / 100,
    peak,
    peakLabel: peakIdx >= 0 ? labels[peakIdx] : '',
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  // Permission guard
  const hasPermission = ctx.role === 'super_admin' || ctx.permissions.includes('view_financials')
  if (!hasPermission) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'view_financials permission required.' } }),
    }
  }

  const qs          = event.queryStringParameters ?? {}
  const period      = (qs.period ?? 'week') as Period
  const storeParam  = qs.store ?? 'all'
  const compareMode = qs.compare === 'true'

  if (!['week', 'month', 'year'].includes(period)) {
    return {
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'period must be week, month, or year.' } }),
    }
  }

  try {
    const [storeRows] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE is_active = 1 ORDER BY name',
    )

    // Determine target stores + response label
    let targetStores: { id: number; name: string }[]
    let responseStore: string

    if (ctx.role !== 'super_admin') {
      const myStore = storeRows.find(s => s.id === Number(ctx.storeId))
      targetStores  = myStore ? [myStore] : []
      responseStore = myStore ? myStore.name.replace(/^Rodz /, '') : 'Unknown'
    } else if (!compareMode && storeParam !== 'all') {
      const found  = storeRows.find(s => s.name.toLowerCase().includes(storeParam.toLowerCase()))
      targetStores = found ? [found] : []
      responseStore = found ? found.name.replace(/^Rodz /, '') : storeParam
    } else {
      targetStores  = storeRows
      responseStore = 'all'
    }

    const cacheKey = `${ctx.role}:${ctx.storeId}:${period}:${responseStore}:${compareMode}`
    const cached   = getCached(cacheKey)
    if (cached) return ok(cached)

    const { start, end } = periodRange(period)
    const labels = periodLabels(period, start)

    // Query all target stores in parallel
    const revenueMaps = await Promise.all(
      targetStores.map(s => queryStore(db, s.id, period, start, end)),
    )

    // Aggregate
    const aggregateMap = new Map<string, number>()
    for (const map of revenueMaps) {
      for (const [k, v] of map) {
        aggregateMap.set(k, (aggregateMap.get(k) ?? 0) + v)
      }
    }

    const values  = buildValues(labels, aggregateMap, period)
    const summary = buildSummary(labels, values)

    const result: any = { store: responseStore, period, chart: { labels, values }, summary }

    // byStore only for super_admin with multiple stores
    if (ctx.role === 'super_admin' && (compareMode || responseStore === 'all') && targetStores.length > 1) {
      result.byStore = targetStores.map((s, i) => ({
        store:  s.name.replace(/^Rodz /, ''),
        values: buildValues(labels, revenueMaps[i], period),
      }))
    }

    setCached(cacheKey, result)
    return ok(result)
  } catch (err) {
    return serverError(err)
  }
}
