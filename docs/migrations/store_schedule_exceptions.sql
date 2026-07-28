-- Per-date overrides for a store's business hours. One row per (store, date).
-- Two flavours:
--   • Closure day        — is_closed = 1, open_time / close_time NULL
--   • Custom hours       — is_closed = 0, open_time + close_time set
--
-- The availability computation (src/shared/bookingSlots.ts) checks this
-- table first; if a row is present for the target date, it overrides the
-- business_hours defaults for that specific date.

CREATE TABLE IF NOT EXISTS store_schedule_exceptions (
  id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id     TINYINT UNSIGNED NOT NULL,
  date         DATE             NOT NULL,
  is_closed    TINYINT(1)       NOT NULL DEFAULT 1,       -- most exceptions are closures
  open_time    TIME             DEFAULT NULL,             -- only meaningful when is_closed = 0
  close_time   TIME             DEFAULT NULL,
  reason       VARCHAR(200)     DEFAULT NULL,             -- e.g. 'Christmas Day', 'Staff training'
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_store_date (store_id, date),
  KEY idx_store_date_range (store_id, date),
  CONSTRAINT fk_sse_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
