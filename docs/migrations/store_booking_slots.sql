-- Store-configurable booking slots. Each row is one bookable time on a
-- given store's day (mon-sat — days off are handled by business_hours).
-- Staff can add, edit, deactivate, or reorder via the workshop portal.
--
-- Seeds three defaults per active store — 08:30, 11:00, 14:00 — built
-- around a 12:00–13:00 lunch and 60-min default booking duration. Staff
-- can add/remove/edit slots via the workshop portal (endpoints in
-- src/stores/booking-slots/*). Range is 2–4 in practice but there's no
-- code cap.

CREATE TABLE IF NOT EXISTS store_booking_slots (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id    TINYINT UNSIGNED NOT NULL,
  slot_time   TIME             NOT NULL,                       -- e.g. '08:30:00'
  label       VARCHAR(40)      DEFAULT NULL,                   -- staff-editable display label
  sort_order  SMALLINT         NOT NULL DEFAULT 0,
  is_active   TINYINT(1)       NOT NULL DEFAULT 1,             -- soft on/off
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_store_time (store_id, slot_time),
  KEY idx_store_active_sort (store_id, is_active, sort_order),
  CONSTRAINT fk_sbs_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seed the three canonical slots for every currently-active store.
-- INSERT IGNORE via the unique key so re-running the migration is safe.
INSERT IGNORE INTO store_booking_slots (store_id, slot_time, label, sort_order)
SELECT id, '08:30:00', 'Morning 1', 0 FROM stores WHERE is_active = 1
UNION ALL SELECT id, '11:00:00', 'Morning 2', 1 FROM stores WHERE is_active = 1
UNION ALL SELECT id, '14:00:00', 'Afternoon', 2 FROM stores WHERE is_active = 1;

-- Align business hours with the new schedule: 08:30 open Mon–Sat (day_of_week 1–6),
-- Sunday stays closed. Weekday close remains 17:30; Saturday close remains 13:00.
UPDATE business_hours SET open_time = '08:30:00' WHERE store_id = 1 AND day_of_week BETWEEN 1 AND 6;
