-- Public vehicle catalog: canonical makes + models.
--
-- Backs the guest booking flow's year -> make -> model cascade and the
-- workshop staff catalog admin UI. Replaces the current freeform
-- vehicles.make / vehicles.model strings as the source of truth for
-- "which cars exist" — real customer vehicles will FK into these tables
-- as they get reassigned.
--
-- Initial seed is generated via scripts/seed-vehicle-catalog.ts (Gemini,
-- year-by-year, additive-only). Staff can then edit / add missing rows
-- (classic imports, obscure trims) through the admin CRUD endpoints.

CREATE TABLE vehicle_makes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(60)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  popular     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_slug (slug),
  KEY idx_popular (popular, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vehicle_models (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  make_id     BIGINT UNSIGNED NOT NULL,
  slug        VARCHAR(80)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  year_start  SMALLINT UNSIGNED NOT NULL,
  year_end    SMALLINT UNSIGNED NOT NULL,
  popular     TINYINT(1)   NOT NULL DEFAULT 0,
  notes       VARCHAR(500) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_make_slug (make_id, slug),
  KEY idx_year_range (make_id, year_start, year_end),
  KEY idx_popular (popular, name),
  CONSTRAINT fk_models_make FOREIGN KEY (make_id) REFERENCES vehicle_makes(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nullable FKs on existing tables. Non-CASCADE / RESTRICT so a staff
-- delete of a make/model that has vehicles pointing at it is blocked at
-- the DB layer; the admin handler will return 409 with the affected
-- count before it ever reaches the constraint check.

ALTER TABLE vehicles
  ADD COLUMN make_id  BIGINT UNSIGNED NULL AFTER model,
  ADD COLUMN model_id BIGINT UNSIGNED NULL AFTER make_id,
  ADD KEY idx_vehicles_catalog_fk (make_id, model_id),
  ADD CONSTRAINT fk_vehicles_make  FOREIGN KEY (make_id)  REFERENCES vehicle_makes(id)  ON DELETE RESTRICT,
  ADD CONSTRAINT fk_vehicles_model FOREIGN KEY (model_id) REFERENCES vehicle_models(id) ON DELETE RESTRICT;

ALTER TABLE vehicle_model_profiles
  ADD COLUMN model_id BIGINT UNSIGNED NULL AFTER year,
  ADD KEY idx_profiles_model (model_id, year),
  ADD CONSTRAINT fk_profiles_model FOREIGN KEY (model_id) REFERENCES vehicle_models(id) ON DELETE RESTRICT;
