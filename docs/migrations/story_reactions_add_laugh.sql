-- Add `laugh` to the story_reactions.kind enum. Appended at the end so
-- existing rows keep their integer ordinals — MySQL only rewrites the row
-- format when the enum is reordered, not extended.
--
-- Idempotent: MODIFY COLUMN is safe to run twice — MySQL treats an
-- identical enum spec as a no-op.

ALTER TABLE story_reactions
  MODIFY COLUMN kind
    ENUM('like','love','fire','wow','thinking','laugh') NOT NULL;
