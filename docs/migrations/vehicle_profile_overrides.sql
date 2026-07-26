-- Per-vehicle overrides for the AI-generated make/model profile.
--
-- The base profile in `vehicle_model_profiles` is shared per
-- (make, model, year) — it holds the workshop-mechanic reference data
-- (engineSpecs, tyreSpecs, commonRepairs) which is genuinely
-- vehicle-agnostic. But the voice-bearing fields — overview,
-- serviceNotes, and each knownIssue's description — need to be
-- per-vehicle so an owner can regenerate them with their chosen tone
-- without stomping on every other owner of the same model.
--
-- Only these fields are stored here; every other field on the profile
-- response still resolves from `vehicle_model_profiles`.
CREATE TABLE vehicle_profile_overrides (
  vehicle_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  tone            ENUM('neutral','nostalgic','sale','enthusiast','casual','concise')
                    NOT NULL DEFAULT 'neutral',
  overview        TEXT   NOT NULL,
  service_notes   JSON   NOT NULL,        -- array of strings, tone-adjusted
  known_issues    JSON   NOT NULL,        -- array of { title, description, severity } — title + severity preserved from base
  regenerated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_vpo_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
