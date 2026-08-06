-- Odometer audit log — one row per successful odometer change on any
-- vehicle. Feeds the workshop "Odometer" tab and confirms that the
-- automatic weekly-bump job is actually keeping things fresh.
--
-- Sources cover every code path that touches vehicles.odometer_current
-- via bumpOdometer(). Backwards writes are only allowed from workshop
-- authoritative sources (job-entry, staff-correction) — see
-- src/shared/odometer.ts for policy.
--
-- Backfill at the bottom stamps one row per existing vehicle with
-- source='backfill' so the history tab is non-empty on day 1.

CREATE TABLE IF NOT EXISTS odometer_history (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id    BIGINT UNSIGNED  NOT NULL,
  previous_km   INT UNSIGNED     NULL,
  new_km        INT UNSIGNED     NOT NULL,
  delta_km      INT              AS (CAST(new_km AS SIGNED) - CAST(IFNULL(previous_km, new_km) AS SIGNED)) STORED,
  source        ENUM(
    'staff-patch','staff-correction','customer-patch','job-entry',
    'fuel-fill','expense','logbook-entry','weekly-bump',
    'booking-create','transfer','ai-agent','backfill'
  )                             NOT NULL,
  actor_type    ENUM('staff','customer','system','ai-agent') NOT NULL,
  actor_id      BIGINT UNSIGNED  NULL,
  source_ref    VARCHAR(64)      NULL,
  notes         VARCHAR(255)     NULL,
  recorded_at   DATETIME         NOT NULL,
  created_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vehicle_recorded (vehicle_id, recorded_at DESC, id DESC),
  KEY idx_actor            (actor_type, actor_id),
  CONSTRAINT fk_odo_hist_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-invocation ledger for the WeeklyOdometerBump EventBridge cron.
-- Every run writes exactly one row, even on failure, so "did the cron
-- run this week?" is a one-query answer.

CREATE TABLE IF NOT EXISTS odometer_bump_runs (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ran_at               DATETIME        NOT NULL,
  duration_ms          INT UNSIGNED    NOT NULL,
  dry_run              TINYINT(1)      NOT NULL DEFAULT 0,
  eligible             INT UNSIGNED    NOT NULL DEFAULT 0,
  bumped               INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_inactive     INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_no_reading   INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_stale        INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_no_owner     INT UNSIGNED    NOT NULL DEFAULT 0,
  failed_vehicle_ids   JSON            NULL,
  error                TEXT            NULL,
  KEY idx_ran_at (ran_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill — one starter row per existing vehicle with a reading, so
-- the "Odometer" tab has an initial anchor. INSERT IGNORE so re-runs of
-- this migration under a fresh checksum are harmless.
INSERT INTO odometer_history
  (vehicle_id, previous_km, new_km, source, actor_type, actor_id, source_ref, notes, recorded_at)
SELECT
  v.id,
  NULL,
  v.odometer_current,
  'backfill',
  'system',
  NULL,
  NULL,
  'Backfilled 2026-08-06 from vehicles.odometer_current',
  COALESCE(v.odometer_recorded_at, v.updated_at, v.created_at, NOW())
FROM vehicles v
LEFT JOIN odometer_history oh
  ON oh.vehicle_id = v.id AND oh.source = 'backfill'
WHERE v.odometer_current IS NOT NULL
  AND oh.id IS NULL;
