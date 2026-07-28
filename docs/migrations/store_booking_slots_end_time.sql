-- Add an explicit end_time to each booking slot so staff can configure
-- variable-length slots (a 30-min tyre-check slot vs a 2-hour service
-- slot, for example).
--
-- Backfill existing rows to slot_time + 60 min — that was the hardcoded
-- default duration before this migration. Idempotent-ish: only touches
-- rows where end_time is NULL (freshly-added column) or matches the
-- placeholder zero.

ALTER TABLE store_booking_slots
  ADD COLUMN end_time TIME NULL AFTER slot_time;

UPDATE store_booking_slots
  SET end_time = ADDTIME(slot_time, '01:00:00')
  WHERE end_time IS NULL;

ALTER TABLE store_booking_slots
  MODIFY COLUMN end_time TIME NOT NULL;
