-- Owner-declared modifications to a vehicle: turbos, exhausts, ECU
-- tunes, suspension, wheels, whatever aftermarket the owner has fitted.
-- Powers the "spec your car" tab on the profile and (optionally, per-mod)
-- the public logbook page.
--
-- Attached media (photos + receipts) live in `vehicle_modification_media`.
-- Receipts also propagate into the expense tracker via `s3_event_index`
-- with category = 'modification' — the media row keeps a back-reference
-- so the two records stay linked.

CREATE TABLE vehicle_modifications (
  id                BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id        BIGINT UNSIGNED       NOT NULL,
  category          ENUM(
                      'engine','forced_induction','exhaust','intake','fuel_system',
                      'ecu_tune','ignition','cooling','transmission','suspension',
                      'brakes','wheels_tyres','interior','exterior','audio',
                      'electronics','other'
                    ) NOT NULL,
  name              VARCHAR(200)          NOT NULL,
  brand             VARCHAR(100)          NULL,
  description       TEXT                  NULL,
  installed_at      DATE                  NULL,
  installed_by      VARCHAR(200)          NULL,       -- workshop name / "self"
  cost_aud          DECIMAL(10, 2)        NULL,       -- total paid (sum of receipts if multiple)
  status            ENUM('installed','removed','planned') NOT NULL DEFAULT 'installed',
  removed_at        DATE                  NULL,
  kept_with_sale    TINYINT(1)            NOT NULL DEFAULT 1,   -- 0 = "coming off before sale"
  is_public         TINYINT(1)            NOT NULL DEFAULT 1,   -- shown on the logbook profile
  cover_image_id    VARCHAR(80)           NULL,                 -- primary hero photo (Cloudflare Images id)
  created_at        DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME              NULL,
  KEY idx_vehicle          (vehicle_id, deleted_at),
  KEY idx_vehicle_category (vehicle_id, category),
  CONSTRAINT fk_vm_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Photos + receipts attached to a modification. `kind = 'receipt'`
-- rows also spawn an s3_event_index expense entry — see below.
CREATE TABLE vehicle_modification_media (
  id                   BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  modification_id      BIGINT UNSIGNED       NOT NULL,
  kind                 ENUM('photo','receipt') NOT NULL DEFAULT 'photo',
  image_id             VARCHAR(80)           NOT NULL,           -- Cloudflare Images id
  caption              VARCHAR(300)          NULL,
  sort_order           SMALLINT              NOT NULL DEFAULT 0,
  -- Receipt-only fields (nullable for kind = 'photo').
  amount_aud           DECIMAL(10, 2)        NULL,
  supplier             VARCHAR(200)          NULL,
  purchased_at         DATE                  NULL,
  -- Back-reference to the expense tracker entry auto-created when
  -- kind = 'receipt'. Null for photo rows. FK to s3_event_index; ON
  -- DELETE SET NULL so a manual expense delete doesn't orphan the media.
  expense_event_id     BIGINT UNSIGNED       NULL,
  created_at           DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_modification (modification_id, sort_order),
  KEY idx_expense_event (expense_event_id),
  CONSTRAINT fk_vmm_mod FOREIGN KEY (modification_id) REFERENCES vehicle_modifications(id) ON DELETE CASCADE,
  CONSTRAINT fk_vmm_expense FOREIGN KEY (expense_event_id) REFERENCES s3_event_index(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
