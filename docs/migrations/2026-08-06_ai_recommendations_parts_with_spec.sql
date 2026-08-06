-- Replace part_name_ids (array of ints) with parts (array of objects)
-- so we can carry a per-vehicle spec string alongside each id — e.g.
-- "0W-16 full synthetic, ~4.4L" for Engine Oil on a Corolla Hybrid.
--
-- part_name_ids shipped 2026-08-06 (same day as this) with no external
-- consumers, so a clean drop is safe. Any rows carrying the old shape
-- get cleared to NULL and pick up the new structure on the next regen.

ALTER TABLE ai_recommendations
  DROP COLUMN part_name_ids,
  ADD COLUMN parts JSON NULL AFTER service_type_id;
