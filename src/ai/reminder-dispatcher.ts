import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { sendMaintenanceReminderEmail } from '../shared/emailTemplates'

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
         AND (r.estimated_due_odometer - (
           CASE
             WHEN v.odometer_recorded_at IS NOT NULL
             THEN v.odometer_current + (DATEDIFF(CURDATE(), v.odometer_recorded_at) * ${KM_PER_DAY})
             ELSE v.odometer_current
           END
         )) BETWEEN 0 AND ?`,
      [KM_THRESHOLD],
    )

    console.log(`ReminderDispatcher: ${rows.length} recommendation(s) due`)

    for (const row of rows) {
      try {
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
        })

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
