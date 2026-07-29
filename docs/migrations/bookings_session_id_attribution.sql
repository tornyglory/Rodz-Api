-- Public booking flow additions on the bookings table.
--
-- session_id (UNIQUE) — client-generated UUID from the guest booking
-- flow so a double-clicked submit doesn't produce duplicate bookings.
-- Repeat POSTs with the same sessionId return the original booking
-- (200) instead of creating (201).
--
-- attribution (JSON) — UTM chain + referer captured on the guest
-- flow. Keeping as JSON so we don't proliferate columns and can add
-- more fields without further migrations.
--
-- NULLable both ways: bookings from other sources (phone, walk-in,
-- staff-created) will have both fields NULL. MySQL allows multiple
-- NULLs in a UNIQUE index so this doesn't break existing writes.

ALTER TABLE bookings
  ADD COLUMN session_id  VARCHAR(36) NULL AFTER booking_ref;

ALTER TABLE bookings
  ADD COLUMN attribution JSON        NULL AFTER booking_source;

ALTER TABLE bookings
  ADD UNIQUE KEY uk_session_id (session_id);
