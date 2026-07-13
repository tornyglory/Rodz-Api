import type mysql from 'mysql2/promise'

// Recomputes vehicle_expense_summary and vehicle_fuel_summary for a vehicle
// from vehicle_expenses. Called after every expense insert/update/delete.
//
// Reasoning: incremental maintenance requires an annual reset job (YTD
// rollover on Jan 1). Recompute-on-write is one small indexed SUM per bucket,
// always correct, no scheduled job needed. At realistic per-vehicle expense
// counts (dozens/year) the extra latency is <10ms.
export async function refreshVehicleSummaries(db: mysql.Pool, vehicleId: number): Promise<void> {
  await Promise.all([
    refreshExpenseSummary(db, vehicleId),
    refreshFuelSummary(db, vehicleId),
  ])
}

async function refreshExpenseSummary(db: mysql.Pool, vehicleId: number): Promise<void> {
  const [[agg]] = await db.query<any[]>(
    `SELECT
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) THEN amount_aud ELSE 0 END), 0) AS total_ytd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) AND expense_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN amount_aud ELSE 0 END), 0) AS total_mtd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) AND category IN ('fuel','ev_charging') THEN amount_aud ELSE 0 END), 0) AS fuel_ytd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) AND category = 'workshop'              THEN amount_aud ELSE 0 END), 0) AS service_ytd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) AND category NOT IN ('fuel','ev_charging','workshop') THEN amount_aud ELSE 0 END), 0) AS other_ytd
     FROM vehicle_expenses WHERE vehicle_id = ?`,
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
  const [[agg]] = await db.query<any[]>(
    `SELECT
       (SELECT expense_date FROM vehicle_expenses
        WHERE vehicle_id = ? AND category IN ('fuel','ev_charging')
        ORDER BY expense_date DESC, id DESC LIMIT 1) AS last_fill_date,
       (SELECT fuel_litres FROM vehicle_expenses
        WHERE vehicle_id = ? AND category IN ('fuel','ev_charging')
        ORDER BY expense_date DESC, id DESC LIMIT 1) AS last_fill_litres,
       (SELECT price_per_litre FROM vehicle_expenses
        WHERE vehicle_id = ? AND category IN ('fuel','ev_charging')
        ORDER BY expense_date DESC, id DESC LIMIT 1) AS last_fill_price,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) THEN amount_aud   ELSE 0 END), 0) AS total_fuel_spend_ytd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) THEN fuel_litres  ELSE 0 END), 0) AS total_litres_ytd,
       COALESCE(SUM(CASE WHEN YEAR(expense_date) = YEAR(CURDATE()) THEN 1            ELSE 0 END), 0) AS fill_count_ytd
     FROM vehicle_expenses
     WHERE vehicle_id = ? AND category IN ('fuel','ev_charging')`,
    [vehicleId, vehicleId, vehicleId, vehicleId],
  )

  // No entries yet — nothing to summarise, and no row required.
  if (!agg.last_fill_date && !agg.fill_count_ytd) return

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
      agg.last_fill_date,
      agg.last_fill_litres,
      agg.last_fill_price,
      agg.total_fuel_spend_ytd,
      agg.total_litres_ytd,
      agg.fill_count_ytd,
    ],
  )
}
