-- Per-vehicle coverage rows the customer manages themselves —
-- registration, WoF / roadworthy, insurance, roadside. One active row per
-- (vehicle, type). Soft-deleted rows accumulate so the customer can
-- create fresh ones without collision.
--
-- Uniqueness rule ("one active per type") is enforced via the virtual
-- generated column `is_active`. MySQL treats NULLs in a unique index as
-- distinct, so multiple deleted rows can share (vehicle_id, type) but
-- only one row with is_active = 1 (deleted_at IS NULL) is allowed.
--
-- Spec: rodz-staff/docs/endpoints/vehicle-policies.md

CREATE TABLE vehicle_policies (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id     BIGINT UNSIGNED NOT NULL,
  customer_id    BIGINT UNSIGNED NOT NULL,
  type           ENUM('registration','wof','insurance','roadside') NOT NULL,
  provider       VARCHAR(200)    NULL,
  policy_number  VARCHAR(120)    NULL,
  cost_aud       DECIMAL(10, 2)  NULL,
  effective_from DATE            NULL,
  expires_on     DATE            NULL,
  phone          VARCHAR(40)     NULL,
  notes          TEXT            NULL,
  image_id       VARCHAR(80)     NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     DATETIME        NULL,
  is_active      TINYINT(1)      GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uk_active_type (vehicle_id, type, is_active),
  KEY idx_vehicle (vehicle_id, deleted_at),
  KEY idx_expires (expires_on, deleted_at),
  CONSTRAINT fk_vp_vehicle  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE CASCADE,
  CONSTRAINT fk_vp_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
