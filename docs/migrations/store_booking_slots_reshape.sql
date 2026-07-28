-- Reshape the seeded slots to match the confirmed 3-slot default:
--   08:30 · Morning 1
--   11:00 · Morning 2
--   14:00 · Afternoon
--
-- The previous migration seeded four slots (08:30, 11:00, 13:30, 15:00).
-- Move the 13:30 rows to 14:00 (rename label to 'Afternoon') and drop the
-- 15:00 rows. Staff can re-add a fourth slot any time via the workshop UI.
--
-- Only touches rows still holding the original seed labels — if a store
-- has already customised their slots, this leaves them alone.

UPDATE store_booking_slots
SET slot_time = '14:00:00', label = 'Afternoon'
WHERE slot_time = '13:30:00' AND label = 'Afternoon 1';

DELETE FROM store_booking_slots
WHERE slot_time = '15:00:00' AND label = 'Afternoon 2';
