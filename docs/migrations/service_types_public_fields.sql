-- Add slug + popular fields to service_types so the public guest
-- booking flow can pre-select via URL param (?service=logbook-service)
-- and render "popular" services as quick-pick chips.
--
-- Also inserts the "Something else" catch-all row so guests can book
-- without matching a specific service_type.

ALTER TABLE service_types
  ADD COLUMN slug VARCHAR(80) NULL AFTER name;

ALTER TABLE service_types
  ADD COLUMN popular TINYINT(1) NOT NULL DEFAULT 0 AFTER slug;

-- Explicit slugs per row — hand-picked instead of slugify(name) because
-- naming quirks in `name` (parentheticals, "per axle", etc.) would
-- produce ugly slugs. These match the URL convention used on marketing
-- landing pages.
UPDATE service_types SET slug = 'small-service'                  WHERE id = 1;
UPDATE service_types SET slug = 'medium-service'                 WHERE id = 2;
UPDATE service_types SET slug = 'large-service'                  WHERE id = 3;
UPDATE service_types SET slug = 'tyre-supply-fit'                WHERE id = 4;
UPDATE service_types SET slug = 'wheel-balance'                  WHERE id = 5;
UPDATE service_types SET slug = 'wheel-alignment-2-wheel'        WHERE id = 6;
UPDATE service_types SET slug = 'wheel-alignment-4-wheel'        WHERE id = 7;
UPDATE service_types SET slug = 'tyre-rotation'                  WHERE id = 8;
UPDATE service_types SET slug = 'brake-pad-replace'              WHERE id = 9;
UPDATE service_types SET slug = 'brake-rotor-replace'            WHERE id = 10;
UPDATE service_types SET slug = 'brake-fluid-flush'              WHERE id = 11;
UPDATE service_types SET slug = 'brake-inspection'               WHERE id = 12;
UPDATE service_types SET slug = 'battery-test'                   WHERE id = 13;
UPDATE service_types SET slug = 'battery-replace'                WHERE id = 14;
UPDATE service_types SET slug = 'air-filter-replace'             WHERE id = 15;
UPDATE service_types SET slug = 'cabin-filter-replace'           WHERE id = 16;
UPDATE service_types SET slug = 'fuel-filter-replace'            WHERE id = 17;
UPDATE service_types SET slug = 'coolant-flush'                  WHERE id = 18;
UPDATE service_types SET slug = 'power-steering-fluid-replace'   WHERE id = 19;
UPDATE service_types SET slug = 'wiper-blade-replace'            WHERE id = 20;
UPDATE service_types SET slug = 'air-con-service'                WHERE id = 21;
UPDATE service_types SET slug = 'air-con-check'                  WHERE id = 22;
UPDATE service_types SET slug = 'shock-absorber-replace'         WHERE id = 23;
UPDATE service_types SET slug = 'suspension-inspection'          WHERE id = 24;
UPDATE service_types SET slug = 'timing-belt-service'            WHERE id = 25;
UPDATE service_types SET slug = 'clutch-replace'                 WHERE id = 26;
UPDATE service_types SET slug = 'pre-purchase-inspection'        WHERE id = 28;

-- Popular flags — top 5 bookable services for the guest picker's
-- quick-pick chips. Small/Medium/Large service = the bulk of bookings;
-- brake inspection + battery test = common check-in triggers.
UPDATE service_types SET popular = 1 WHERE id IN (1, 2, 3, 12, 13);

-- "Something else" catch-all so guests can book without picking a
-- specific service_type. The workshop reads the free-text intent
-- field on booking creation and reassigns after triage.
INSERT INTO service_types (
  name, slug, category, description,
  labour_hours_estimate, labour_rate, complexity,
  hoist_required, tyre_bay_job, sort_order,
  is_active, is_bookable, popular
) VALUES (
  'Something else', 'other', 'other',
  'Not sure — tell us what you''d like looked at',
  1.00, 0.00, 'moderate',
  0, 0, 999,
  1, 1, 1
);

-- Enforce uniqueness after backfill (allows multiple NULL rows during
-- rollout if any slugs are still missing — MySQL allows NULLs in
-- UNIQUE keys).
ALTER TABLE service_types
  ADD UNIQUE KEY uk_slug (slug);
