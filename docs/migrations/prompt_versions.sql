-- Versioned assistant prompts.
--
-- The customer chat handler reads the ACTIVE row from this table and
-- composes it with the dynamic per-request context (customer name,
-- vehicle facts, memory) at request time. Every change to the prompt —
-- manual save, "apply Rodz's edits" from the feedback review, or a
-- revert — writes a NEW immutable row. History is a story, not a diff.
--
-- Exactly one row is active at a time — enforced by the virtual
-- `_active_lock` column + UNIQUE trick we already use in
-- `vehicle_policies`. `is_active = 1` on the active row, `0` on all
-- others; the virtual column is 1 for the active row and NULL for the
-- rest, and MySQL treats NULLs in a UNIQUE as distinct.
--
-- `learned_guidance` accumulates instructions the operator applied from
-- Rodz's own review of 👎 feedback (see `POST /admin/chat-feedback/review`
-- + `POST /admin/prompts/apply-edits`). Shape:
--   [
--     {
--       "instruction":  "...",
--       "rationale":    "...",
--       "target":       "system-prompt" | "agent",
--       "agentName":    null | "expense" | "booking" | ...,
--       "addedAt":      "2026-07-20T14:29:11.000Z",
--       "addedBy":      3,
--       "fromReview":   { "windowDays": 7, "reviewedCount": 12 }
--     }
--   ]
--
-- Version labels: `v{N}-{YYYY-MM-DD}-{HH:mm}[-slug]` where N monotonically
-- increases across all rows (never re-uses a number, even after reverts).

CREATE TABLE prompt_versions (
  id                 BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version_label      VARCHAR(80)           NOT NULL,
  base_prompt        MEDIUMTEXT            NOT NULL,
  learned_guidance   JSON                  NOT NULL,
  notes              VARCHAR(500)          NULL,
  source             ENUM('manual', 'review-apply', 'revert') NOT NULL DEFAULT 'manual',
  source_review      JSON                  NULL,
  parent_version_id  BIGINT UNSIGNED       NULL,
  saved_by           BIGINT UNSIGNED       NOT NULL,
  saved_at           DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active          TINYINT(1)            NOT NULL DEFAULT 0,
  -- Virtual column that is 1 for the active row and NULL for all
  -- others. Paired with UNIQUE below to enforce "only one active row".
  _active_lock       TINYINT(1)            GENERATED ALWAYS AS (IF(is_active = 1, 1, NULL)) VIRTUAL,
  UNIQUE KEY uk_version_label (version_label),
  UNIQUE KEY uk_active_lock (_active_lock),
  KEY idx_saved_at (saved_at DESC),
  CONSTRAINT fk_prompt_versions_parent FOREIGN KEY (parent_version_id) REFERENCES prompt_versions(id) ON DELETE SET NULL,
  CONSTRAINT fk_prompt_versions_staff  FOREIGN KEY (saved_by)          REFERENCES staff(id)          ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
