-- Feature flags — v1 global on/off per key.
-- Admin toggles from Settings; customer app hydrates from GET /c/feature-flags.
-- Missing keys default to `enabled = true` on the frontend (fail-open),
-- so a new flag can ship without disruption before rows are seeded.
--
-- `key` is a MySQL reserved word so we name the column `flag_key`. Frontend
-- contract still exposes it as `key` in the JSON payload.
--
-- Brief: docs/feature-flags-backend-brief.md (source of the specifics below).

CREATE TABLE feature_flags (
  flag_key    VARCHAR(100)    NOT NULL PRIMARY KEY,
  enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  description VARCHAR(500)    NULL,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by  BIGINT UNSIGNED NULL,
  CONSTRAINT fk_flag_updated_by FOREIGN KEY (updated_by) REFERENCES staff(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('customer.chat',           1, 'AI vehicle chat / Rodz Assistant'),
  ('customer.logbook',        1, 'Digital Logbook (service history entries)'),
  ('customer.maintenance',    1, 'Maintenance schedule + recommendations'),
  ('customer.expenses',       1, 'Expense Tracker (Gold-tier feature)'),
  ('customer.paperwork',      1, 'Paperwork page — quotes + invoices list'),
  ('customer.vehicleHealth',  1, 'Vehicle Health dashboard'),
  ('customer.voiceMode',      1, 'Voice-mode chat (mic + TTS)'),
  ('customer.photoGallery',   1, 'Vehicle photo gallery on the profile page'),
  ('customer.onboarding',     1, 'First-signup onboarding wizard');
