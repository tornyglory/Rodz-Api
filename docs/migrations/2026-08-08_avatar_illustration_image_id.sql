-- Nano-Banana-generated illustrations of avatars/covers. Nullable
-- on each table — record keeps the raw photo (avatar_image_id) as
-- source of truth; illustration is opt-in per-record.
--
-- Rendering fallback pattern (client-side):
--   illustrationUrl ?? avatarUrl ?? placeholder

ALTER TABLE staff
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;

ALTER TABLE customers
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;

ALTER TABLE vehicles
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;
