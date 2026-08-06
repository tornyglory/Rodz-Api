import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { sendMaintenanceReminderEmail } from '../shared/emailTemplates'
import { pushToCustomer } from '../shared/push'

const ready = bootstrap()

const KM_THRESHOLD  = 2000
const KM_PER_DAY    = 41  // ~15,000 km/year Australian average

export const handler = async (): Promise<void> => {
  await ready
  const db = getPool()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT
         r.id              AS rec_id,
         r.vehicle_id,
         r.customer_id,
         r.title,
         r.recommendation_body,
         r.urgency,
         r.estimated_due_odometer,
         r.estimated_cost_min,
         r.estimated_cost_max,
         v.make, v.model, v.year, v.rego,
         v.odometer_current,
         v.odometer_recorded_at,
         CASE
           WHEN v.odometer_recorded_at IS NOT NULL
           THEN v.odometer_current + (DATEDIFF(CURDATE(), v.odometer_recorded_at) * ${KM_PER_DAY})
           ELSE v.odometer_current
         END AS predicted_km,
         c.email, c.first_name
       FROM ai_recommendations r
       JOIN vehicles v  ON v.id = r.vehicle_id  AND v.is_active = 1
       JOIN customers c ON c.id = r.customer_id AND c.is_active = 1
       WHERE r.status = 'active'
         AND r.estimated_due_odometer IS NOT NULL
         AND v.odometer_current IS NOT NULL
         -- Cast to SIGNED so the (due - predicted) subtraction can go
         -- negative without blowing up on BIGINT UNSIGNED underflow when
         -- a service is already past due. The BETWEEN filter drops
         -- negatives anyway (they were already sent or missed).
         AND (CAST(r.estimated_due_odometer AS SIGNED) - CAST((
           CASE
             WHEN v.odometer_recorded_at IS NOT NULL
             THEN v.odometer_current + (DATEDIFF(CURDATE(), v.odometer_recorded_at) * ${KM_PER_DAY})
             ELSE v.odometer_current
           END
         ) AS SIGNED)) BETWEEN 0 AND ?`,
      [KM_THRESHOLD],
    )

    console.log(`ReminderDispatcher: ${rows.length} recommendation(s) due`)

    for (const row of rows) {
      try {
        // Deep-link both the email CTA and the push notification to the
        // exact recommendation card so the customer lands on the item
        // they were reminded about — not just the maintenance tab.
        // Path-segment rec id matches the frontend router shape:
        //   /account/vehicles/{vid}/maintenance/{recId}
        // (nested child route inside AccountVehicleView; opens the
        // recommendation detail slide-up modal).
        const recPath = `/account/vehicles/${row.vehicle_id}/maintenance/${row.rec_id}`

        await sendMaintenanceReminderEmail(db, {
          customerEmail: row.email,
          firstName:     row.first_name,
          vehicleLabel:  `${row.year} ${row.make} ${row.model}`,
          rego:          row.rego,
          title:         row.title,
          body:          row.recommendation_body,
          urgency:       row.urgency,
          currentKm:     Number(row.predicted_km ?? row.odometer_current),
          dueKm:         Number(row.estimated_due_odometer),
          costMin:       row.estimated_cost_min ? Number(row.estimated_cost_min) : null,
          costMax:       row.estimated_cost_max ? Number(row.estimated_cost_max) : null,
          recPath,
        })

        // Push notification alongside the email. pushToCustomer handles
        // the whole gating chain internally: service_due pref column,
        // quiet hours, per-day rate limits, 30-day dedupe (keyed on
        // eventId = `maintenance_due:{rec_id}`), and a fallback audit
        // row when the customer has no registered device tokens. So the
        // customer still sees the reminder in the portal notification
        // centre even if they haven't installed the mobile app.
        try {
          const dueInKm = Math.max(0, Number(row.estimated_due_odometer) - Number(row.predicted_km ?? row.odometer_current))
          await pushToCustomer(db, Number(row.customer_id), {
            type:      'maintenance_due',
            title:     `${row.year} ${row.make} ${row.model} — service coming up`,
            body:      dueInKm > 0
              ? `${row.title} — due in about ${dueInKm.toLocaleString()} km.`
              : `${row.title} — due now.`,
            deeplink:  recPath,
            eventId:   `maintenance_due:${row.rec_id}`,
            vehicleId: Number(row.vehicle_id),
          })
        } catch (pushErr) {
          console.error(`Failed to send push for rec_id ${row.rec_id}:`, pushErr)
        }

        await db.query(
          `UPDATE ai_recommendations
           SET status = 'sent', sent_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [row.rec_id],
        )

        try {
          await db.query(
            `INSERT INTO notifications
               (customer_id, vehicle_id, channel, notification_type, subject, body, status, sent_at)
             VALUES (?, ?, 'email', 'service', ?, ?, 'sent', NOW())`,
            [
              row.customer_id,
              row.vehicle_id,
              `Your ${row.year} ${row.make} ${row.model} — ${row.title}`,
              row.recommendation_body,
            ],
          )
        } catch (notifErr) {
          console.error(`Failed to log notification for rec_id ${row.rec_id}:`, notifErr)
        }
      } catch (err) {
        console.error(`Failed to send reminder for rec_id ${row.rec_id}:`, err)
      }
    }
  } catch (err) {
    console.error('ReminderDispatcher error:', err)
    throw err
  }
}
