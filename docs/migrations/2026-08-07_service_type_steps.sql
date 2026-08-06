-- Job card checklist infrastructure.
--
-- Three tables:
--   service_type_steps        — ordered list of steps per service_type
--   service_type_step_parts   — parts consumed at each step (FK to part_names)
--   service_job_step_progress — per-job tick-off state (one row per job×step)
--
-- Steps are generic per service (same for every Corolla oil change);
-- vehicle-specific detail (5W-30 vs 0W-16, capacity, OEM part refs)
-- comes from ai_recommendations.parts[].spec at job-card render time.
--
-- service_jobs.progress (existing tinyint) will be recomputed by app
-- code on every progress-row write: floor(100 * completed / non_optional_total).

CREATE TABLE IF NOT EXISTS service_type_steps (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_type_id   BIGINT UNSIGNED   NOT NULL,
  step_number       SMALLINT UNSIGNED NOT NULL,
  title             VARCHAR(120)      NOT NULL,
  description       TEXT              NULL,
  estimated_mins    SMALLINT UNSIGNED NULL,
  is_optional       TINYINT(1)        NOT NULL DEFAULT 0,
  is_safety_check   TINYINT(1)        NOT NULL DEFAULT 0,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_service_step_order (service_type_id, step_number),
  KEY idx_service (service_type_id, step_number),
  CONSTRAINT fk_step_service FOREIGN KEY (service_type_id) REFERENCES service_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS service_type_step_parts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  step_id        BIGINT UNSIGNED NOT NULL,
  part_name_id   INT UNSIGNED    NOT NULL,
  is_optional    TINYINT(1)      NOT NULL DEFAULT 0,
  sort_order     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_step_part (step_id, part_name_id),
  KEY idx_step (step_id, sort_order),
  CONSTRAINT fk_stp_step FOREIGN KEY (step_id)      REFERENCES service_type_steps(id) ON DELETE CASCADE,
  CONSTRAINT fk_stp_part FOREIGN KEY (part_name_id) REFERENCES part_names(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS service_job_step_progress (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_job_id        BIGINT UNSIGNED NOT NULL,
  step_id               BIGINT UNSIGNED NOT NULL,
  status                ENUM('pending','in_progress','completed','skipped') NOT NULL DEFAULT 'pending',
  completed_by_staff_id BIGINT UNSIGNED NULL,
  completed_at          DATETIME        NULL,
  notes                 VARCHAR(500)    NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_step (service_job_id, step_id),
  KEY idx_job (service_job_id),
  CONSTRAINT fk_sjsp_job  FOREIGN KEY (service_job_id) REFERENCES service_jobs(id)      ON DELETE CASCADE,
  CONSTRAINT fk_sjsp_step FOREIGN KEY (step_id)        REFERENCES service_type_steps(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
