-- Extended customer profile fields for the app's "user profile" page.
-- Everything is optional / nullable — existing customers keep the empty
-- state and fill fields in over time. No default values, no required
-- migrations of existing rows.
--
-- `avatar_image_id` and `description` (used as the bio) already exist
-- on customers, so they're not added here.
--
-- Cloudflare Images ids follow the same convention as
-- vehicles.cover_image_id / vehicles.avatar_image_id — 80 chars.

ALTER TABLE customers
  ADD COLUMN cover_image_id      VARCHAR(80)  NULL,
  ADD COLUMN dream_car           VARCHAR(100) NULL,
  ADD COLUMN favourite_drive     VARCHAR(200) NULL,
  ADD COLUMN driving_since_year  SMALLINT     NULL;
