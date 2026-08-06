import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'

const ready = bootstrap()

const DEFAULT_LIMIT = 30
const MAX_LIMIT     = 200

// Super-admin observability: "did the weekly-odometer-bump cron run?"
// One row per invocation of the EventBridge Lambda, recorded whether the
// run succeeded or blew up. Sorted newest first.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const q = event.queryStringParameters ?? {}
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT))

  try {
    const [rows] = await db.query<any[]>(
      `SELECT id, ran_at, duration_ms, dry_run, eligible, bumped,
              skipped_inactive, skipped_no_reading, skipped_stale, skipped_no_owner,
              failed_vehicle_ids, error
       FROM odometer_bump_runs
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    )

    const runs = rows.map(r => ({
      id:                Number(r.id),
      ranAt:             new Date(r.ran_at).toISOString(),
      durationMs:        Number(r.duration_ms),
      dryRun:            !!r.dry_run,
      eligible:          Number(r.eligible),
      bumped:            Number(r.bumped),
      skipped: {
        inactive:   Number(r.skipped_inactive),
        noReading:  Number(r.skipped_no_reading),
        stale:      Number(r.skipped_stale),
        noOwner:    Number(r.skipped_no_owner),
      },
      failedVehicleIds:  r.failed_vehicle_ids ? (typeof r.failed_vehicle_ids === 'string' ? JSON.parse(r.failed_vehicle_ids) : r.failed_vehicle_ids) : null,
      error:             r.error ?? null,
    }))

    return ok({ runs })
  } catch (err) {
    return serverError(err)
  }
}
