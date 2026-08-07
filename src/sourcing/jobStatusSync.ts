import type mysql from 'mysql2/promise'

// Given a booking, look at the parts-order state + reconcile the
// linked service_jobs.status:
//   * All non-cancelled orders `arrived`     → nudge from 'awaiting_parts' back to 'open'
//   * Any non-arrived / non-cancelled order  → nudge from 'open' to 'awaiting_parts'
//
// Never touches terminal / in-progress states (in_progress, completed,
// invoiced, cancelled) — the mechanic's already past this stage and we
// don't want a late-arrival flip to derail active work.
//
// Also lazily populates part_orders.service_job_id — bookings often
// spawn a job later than the order is placed, so we backfill on every
// sync pass.

const ELIGIBLE_STATUSES = new Set(['open', 'awaiting_parts'])

export async function syncJobStatusFromOrders(
  db: mysql.Pool,
  bookingId: number,
): Promise<{ jobId: number | null; newStatus: string | null; changed: boolean }> {
  // Find the job for this booking (if one exists)
  const [[job]] = await db.query<any[]>(
    `SELECT id, status FROM service_jobs WHERE booking_id = ? LIMIT 1`,
    [bookingId],
  )
  if (!job) return { jobId: null, newStatus: null, changed: false }

  // Lazily backfill service_job_id on any part_orders that didn't
  // have it (e.g. order placed before the job was materialised).
  await db.query(
    `UPDATE part_orders SET service_job_id = ?
     WHERE booking_id = ? AND service_job_id IS NULL`,
    [job.id, bookingId],
  )

  // Only reconcile when the job is in an eligible state.
  if (!ELIGIBLE_STATUSES.has(String(job.status))) {
    return { jobId: Number(job.id), newStatus: String(job.status), changed: false }
  }

  const [[stats]] = await db.query<any[]>(
    `SELECT
       SUM(CASE WHEN status = 'arrived'   THEN 1 ELSE 0 END) AS arrived_ct,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_ct,
       COUNT(*) AS total_ct
     FROM part_orders WHERE booking_id = ?`,
    [bookingId],
  )
  const total     = Number(stats?.total_ct ?? 0)
  const arrived   = Number(stats?.arrived_ct ?? 0)
  const cancelled = Number(stats?.cancelled_ct ?? 0)
  const effective = total - cancelled   // non-cancelled orders

  let target: string
  if (total === 0) {
    // No orders placed → workshop hasn't started sourcing. Leave 'open'.
    target = 'open'
  } else if (effective > 0 && arrived >= effective) {
    // Every non-cancelled order arrived — parts are ready.
    target = 'open'
  } else {
    // At least one non-cancelled order still pending.
    target = 'awaiting_parts'
  }

  if (target === String(job.status)) {
    return { jobId: Number(job.id), newStatus: target, changed: false }
  }

  await db.query(
    `UPDATE service_jobs SET status = ?, updated_at = NOW() WHERE id = ?`,
    [target, job.id],
  )
  return { jobId: Number(job.id), newStatus: target, changed: true }
}
