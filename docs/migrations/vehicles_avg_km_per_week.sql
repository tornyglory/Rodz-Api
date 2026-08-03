-- Customer's declared average weekly km. Populated at vehicle-create
-- time from a form field (customer portal, workshop staff, guest
-- booking). NULL is a first-class value: the weekly-odometer-bump
-- job falls back to a 240 km/week default when no per-customer value
-- exists (matches ABS's 2024 AU average of ~12,500 km/year).
--
-- Kept as INT UNSIGNED — no fractional km, and cars doing 65k+ per
-- year (rideshare, courier) are well within range.
ALTER TABLE vehicles
  ADD COLUMN avg_km_per_week INT UNSIGNED NULL AFTER odometer_recorded_at;
