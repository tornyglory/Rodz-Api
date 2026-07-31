-- Device / browser / network / coarse-geo signals captured at booking
-- submit. Powers attribution reporting, fraud checks, and future
-- store-assignment heuristics ("customer in Frankston area →
-- suggest Frankston store").
--
-- Stored as JSON (rather than flat columns) because the fields are
-- log-ish — many optional signals, unlikely to be filtered or GROUPed
-- as regularly as the UTM columns. If a specific field starts driving
-- reporting queries, add a functional index on it via
-- JSON_EXTRACT(submission_context, '$.country') etc.
--
-- Nullable — existing rows stay NULL; not-through-guest-form bookings
-- (staff-created, phone, walk-in) don't populate this either.

ALTER TABLE bookings
  ADD COLUMN submission_context JSON NULL
  COMMENT 'Device / browser / geo signals at submit time. See docs/migrations/bookings_submission_context.sql.';
