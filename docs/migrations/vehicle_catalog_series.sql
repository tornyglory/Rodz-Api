-- Vehicle model series — third level of the catalog hierarchy.
--
-- Falcon spans 1960→2016 as a single model row, but the meaningful
-- workshop distinctions live at the series level: XA (1972-73),
-- XB (1973-76), XC (1976-79), XD/XE/XF, EA/EB/ED, AU, BA/BF, FG.
-- Same story for Skyline (R32/R34), Commodore (VB→VF), 3-Series
-- (E30/E36/E46/E90/F30/G20), LandCruiser (40/60/70/80/100/200/300).
--
-- Optional relationship: modern cars like Corolla / Yaris don't have
-- meaningful series distinctions and get no rows in this table. The
-- guest picker skips the series step when the model has no series rows
-- for the selected year.

CREATE TABLE vehicle_model_series (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model_id    BIGINT UNSIGNED NOT NULL,
  slug        VARCHAR(60)     NOT NULL,
  name        VARCHAR(80)     NOT NULL,
  year_start  SMALLINT UNSIGNED NOT NULL,
  year_end    SMALLINT UNSIGNED NOT NULL,
  popular     TINYINT(1)      NOT NULL DEFAULT 0,
  notes       VARCHAR(500)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_model_slug (model_id, slug),
  KEY idx_year_range (model_id, year_start, year_end),
  CONSTRAINT fk_series_model FOREIGN KEY (model_id) REFERENCES vehicle_models(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- FK on vehicles. Optional — leave NULL for cars where the customer
-- doesn't know or the model has no meaningful series distinctions. The
-- freeform `vehicles.series` column stays as a text fallback for cases
-- where the catalog hasn't got the specific series yet.

ALTER TABLE vehicles
  ADD COLUMN series_id BIGINT UNSIGNED NULL AFTER model_id,
  ADD KEY idx_vehicles_series (series_id),
  ADD CONSTRAINT fk_vehicles_series FOREIGN KEY (series_id) REFERENCES vehicle_model_series(id) ON DELETE RESTRICT;
