import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

// Human-readable labels for the `source` enum. The frontend can render
// these directly or map to its own copy — either way the value is stable.
const SOURCE_LABELS: Record<string, string> = {
  'staff-patch':       'Staff update',
  'staff-correction':  'Staff correction',
  'customer-patch':    'Customer update',
  'job-entry':         'Job entry',
  'fuel-fill':         'Fuel fill',
  'expense':           'Expense',
  'logbook-entry':     'Logbook entry',
  'weekly-bump':       'Weekly bump',
  'booking-create':    'Booking',
  'transfer':          'Ownership transfer',
  'ai-agent':          'AI assistant',
  'backfill':          'Initial reading (backfilled)',
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}
  const q = event.queryStringParameters ?? {}

  try {
    // Vehicle-belongs-to-customer + store guard (same pattern as
    // recommendations endpoint — Number() coerce so store_manager works).
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       WHERE v.id = ? AND vo.customer_id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId, customerId],
    )
    if (!vehicle) return notFound('Vehicle')

    if (ctx.role !== 'super_admin') {
      const [[customer]] = await db.query<any[]>(
        'SELECT store_id FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (Number(customer?.store_id) !== Number(ctx.storeId)) return notFound('Vehicle')
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT))
    const before = q.before ? Number(q.before) : null

    // Fetch one extra row so we can compute hasMore + nextCursor without
    // a separate COUNT query.
    const params: any[] = [vehicleId]
    let whereCursor = ''
    if (before && Number.isInteger(before)) {
      whereCursor = ' AND h.id < ?'
      params.push(before)
    }

    const [rows] = await db.query<any[]>(
      `SELECT
         h.id, h.previous_km, h.new_km, h.delta_km, h.source,
         h.actor_type, h.actor_id, h.source_ref, h.notes, h.recorded_at,
         s.first_name  AS staff_first,  s.last_name  AS staff_last,
         c.first_name  AS cust_first,   c.last_name  AS cust_last
       FROM odometer_history h
       LEFT JOIN staff     s ON h.actor_type = 'staff'    AND s.id = h.actor_id
       LEFT JOIN customers c ON h.actor_type = 'customer' AND c.id = h.actor_id
       WHERE h.vehicle_id = ?${whereCursor}
       ORDER BY h.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    )

    const hasMore    = rows.length > limit
    const pageRows   = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? Number(pageRows[pageRows.length - 1].id) : null

    const history = pageRows.map(r => ({
      id:          Number(r.id),
      previousKm:  r.previous_km != null ? Number(r.previous_km) : null,
      newKm:       Number(r.new_km),
      deltaKm:     Number(r.delta_km),
      source:      r.source,
      sourceLabel: SOURCE_LABELS[r.source] ?? r.source,
      actor: {
        type:        r.actor_type,
        id:          r.actor_id != null ? Number(r.actor_id) : null,
        displayName: actorDisplayName(r),
      },
      sourceRef:   r.source_ref ?? null,
      notes:       r.notes ?? null,
      recordedAt:  new Date(r.recorded_at).toISOString(),
    }))

    // Stats block — three windowed sums + first reading + source counts.
    // All indexed, cheap. Runs against the full history for this vehicle,
    // ignoring the cursor.
    const [[stats]] = await db.query<any[]>(
      `SELECT
         COUNT(*)                                                             AS total_readings,
         MIN(recorded_at)                                                     AS first_recorded,
         MAX(new_km)                                                          AS latest_km,
         COALESCE(SUM(CASE WHEN recorded_at >= NOW() - INTERVAL 30  DAY  THEN GREATEST(delta_km, 0) ELSE 0 END), 0) AS km_30d,
         COALESCE(SUM(CASE WHEN recorded_at >= NOW() - INTERVAL 90  DAY  THEN GREATEST(delta_km, 0) ELSE 0 END), 0) AS km_90d,
         COALESCE(SUM(CASE WHEN recorded_at >= NOW() - INTERVAL 365 DAY  THEN GREATEST(delta_km, 0) ELSE 0 END), 0) AS km_365d
       FROM odometer_history
       WHERE vehicle_id = ?`,
      [vehicleId],
    )

    const [sourceRows] = await db.query<any[]>(
      `SELECT source, COUNT(*) AS n
       FROM odometer_history
       WHERE vehicle_id = ?
       GROUP BY source`,
      [vehicleId],
    )
    const sourceCounts: Record<string, number> = {}
    for (const r of sourceRows) sourceCounts[r.source] = Number(r.n)

    return ok({
      stats: {
        totalReadings:  Number(stats?.total_readings ?? 0),
        firstReadingAt: stats?.first_recorded ? new Date(stats.first_recorded).toISOString() : null,
        latestKm:       stats?.latest_km != null ? Number(stats.latest_km) : null,
        kmLast30Days:   Number(stats?.km_30d  ?? 0),
        kmLast90Days:   Number(stats?.km_90d  ?? 0),
        kmLast365Days:  Number(stats?.km_365d ?? 0),
        sourceCounts,
      },
      history,
      hasMore,
      nextCursor,
    })
  } catch (err) {
    return serverError(err)
  }
}

function actorDisplayName(r: any): string {
  if (r.actor_type === 'staff'    && r.staff_first) return `${r.staff_first} ${r.staff_last ?? ''}`.trim()
  if (r.actor_type === 'customer' && r.cust_first)  return `${r.cust_first} ${r.cust_last ?? ''}`.trim()
  if (r.actor_type === 'system')                    return 'System'
  if (r.actor_type === 'ai-agent')                  return 'AI assistant'
  return 'Unknown'
}
