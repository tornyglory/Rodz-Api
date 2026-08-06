-- Backfill notification_events.deeplink for maintenance_due rows sent
-- before 2026-08-07 (path-segment rec id in the URL). Historical rows
-- were written with the pre-brief tab-level path
-- (/account/vehicles/{vid}/maintenance) which lands the customer on
-- the maintenance tab but doesn't open the recommendation detail modal.
--
-- The frontend router (nested child route at .../maintenance/{recId})
-- expects the rec id as a path segment. Rewrites in-place so the
-- notifications list opens the specific rec on tap.
--
-- Idempotent: only touches rows still on the old tab-level path OR the
-- interim ?rec={id} query-param form.
--
-- Rec id is parsed from the event_id, which is stamped by
-- reminder-dispatcher as "maintenance_due:{rec_id}".

UPDATE notification_events
SET deeplink = CONCAT(
  '/account/vehicles/', vehicle_id,
  '/maintenance/',      SUBSTRING_INDEX(event_id, ':', -1)
)
WHERE type = 'maintenance_due'
  AND vehicle_id IS NOT NULL
  AND event_id LIKE 'maintenance_due:%'
  AND (
    deeplink = CONCAT('/account/vehicles/', vehicle_id, '/maintenance')
    OR deeplink LIKE CONCAT('/account/vehicles/', vehicle_id, '/maintenance?%')
  );
