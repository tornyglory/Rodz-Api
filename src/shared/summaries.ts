import type mysql from 'mysql2/promise'
import { readFromDataLake } from './dataLake'

// Recomputes vehicle_expense_summary and vehicle_fuel_summary for a vehicle
// from s3_event_index. Called after every expense create/update/delete.
//
// Uses denormalised amount_aud + category on s3_event_index so no S3 fetches
// are needed for the money-aggregate rollups. Fuel-specific fields (last
// fill litres/price) require a single S3 fetch of the most recent fuel row.
export async function refreshVehicleSummaries(db: mysql.Pool, vehicleId: number): Promise<void> {
  await Promise.all([
    refreshExpenseSummary(db, vehicleId),
    refreshFuelSummary(db, vehicleId),
  ])
}

async function refreshExpenseSummary(db: mysql.Pool, vehicleId: number): Promise<void> {
  const [[agg]] = await db.query<any[]>(
    `SELECT
       COALESCE(SUM(CASE WHEN YEAR(event_date) = YEAR(CURDATE())                                                                                 THEN amount_aud ELSE 0 END), 0) AS total_ytd,
       COALESCE(SUM(CASE WHEN YEAR(event_date) = YEAR(CURDATE()) AND event_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')                          THEN amount_aud ELSE 0 END), 0) AS total_mtd,
       COALESCE(SUM(CASE WHEN YEAR(event_date) = YEAR(CURDATE()) AND category IN ('fuel','ev_charging')                                        THEN amount_aud ELSE 0 END), 0) AS fuel_ytd,
       COALESCE(SUM(CASE WHEN YEAR(event_date) = YEAR(CURDATE()) AND category = 'workshop'                                                     THEN amount_aud ELSE 0 END), 0) AS service_ytd,
       COALESCE(SUM(CASE WHEN YEAR(event_date) = YEAR(CURDATE()) AND category NOT IN ('fuel','ev_charging','workshop') AND amount_aud IS NOT NULL THEN amount_aud ELSE 0 END), 0) AS other_ytd
     FROM s3_event_index
     WHERE vehicle_id = ? AND event_type IN ('fuel-fills','expenses')`,
    [vehicleId],
  )

  await db.query(
    `INSERT INTO vehicle_expense_summary
       (vehicle_id, total_spend_mtd, total_spend_ytd, fuel_spend_ytd, service_spend_ytd, other_spend_ytd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_spend_mtd   = VALUES(total_spend_mtd),
       total_spend_ytd   = VALUES(total_spend_ytd),
       fuel_spend_ytd    = VALUES(fuel_spend_ytd),
       service_spend_ytd = VALUES(service_spend_ytd),
       other_spend_ytd   = VALUES(other_spend_ytd)`,
    [vehicleId, agg.total_mtd, agg.total_ytd, agg.fuel_ytd, agg.service_ytd, agg.other_ytd],
  )
}

async function refreshFuelSummary(db: mysql.Pool, vehicleId: number): Promise<void> {
  const [rows] = await db.query<any[]>(
    `SELECT id, s3_key, event_date, amount_aud
     FROM s3_event_index
     WHERE vehicle_id = ? AND event_type = 'fuel-fills'
     ORDER BY event_date DESC, id DESC`,
    [vehicleId],
  )

  if (rows.length === 0) {
    // Wipe the summary row if no fuel fills exist.
    await db.query('DELETE FROM vehicle_fuel_summary WHERE vehicle_id = ?', [vehicleId])
    return
  }

  const currentYear = new Date().getFullYear()
  const ytdRows     = rows.filter(r => new Date(r.event_date).getFullYear() === currentYear)
  const totalYtd    = ytdRows.reduce((s, r) => s + Number(r.amount_aud ?? 0), 0)
  const countYtd    = ytdRows.length

  // Fetch just the most recent fuel object to get litres/price. One S3 GET.
  const latest = await readFromDataLake<any>(rows[0].s3_key)

  // Sum litres for YTD — needs S3 reads for each row. Bounded (typically <30 fills/year).
  let totalLitresYtd = 0
  if (ytdRows.length > 0) {
    const details = await Promise.all(ytdRows.map(r => readFromDataLake<any>(r.s3_key)))
    for (const d of details) {
      if (d && d.litres != null) totalLitresYtd += Number(d.litres)
    }
  }

  await db.query(
    `INSERT INTO vehicle_fuel_summary
       (vehicle_id, last_fill_date, last_fill_litres, last_fill_price,
        total_fuel_spend_ytd, total_litres_ytd, fill_count_ytd)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_fill_date       = VALUES(last_fill_date),
       last_fill_litres     = VALUES(last_fill_litres),
       last_fill_price      = VALUES(last_fill_price),
       total_fuel_spend_ytd = VALUES(total_fuel_spend_ytd),
       total_litres_ytd     = VALUES(total_litres_ytd),
       fill_count_ytd       = VALUES(fill_count_ytd)`,
    [
      vehicleId,
      latest?.expenseDate ?? rows[0].event_date,
      latest?.litres        ?? null,
      latest?.pricePerLitre ?? null,
      totalYtd,
      totalLitresYtd,
      countYtd,
    ],
  )
}
