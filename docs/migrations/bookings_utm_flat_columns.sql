-- Move guest-booking attribution from a JSON blob to flat columns.
--
-- The earlier bookings_session_id_attribution migration added an
-- attribution JSON column. That was fine for flexibility but poor
-- for the reporting use case marketing actually wants ("which
-- channels convert best") — that use case needs indexable columns,
-- GROUP BY-friendly types, and predictable WHERE clauses.
--
-- Flat columns are nullable so existing bookings + non-marketing
-- traffic (staff phone-ins, walk-ins) don't need dummy values.
-- Length caps are generous — Facebook campaign names can push past
-- 100 chars.

ALTER TABLE bookings
  ADD COLUMN utm_source   VARCHAR(64)  NULL AFTER attribution,
  ADD COLUMN utm_medium   VARCHAR(64)  NULL AFTER utm_source,
  ADD COLUMN utm_campaign VARCHAR(128) NULL AFTER utm_medium,
  ADD COLUMN referer_url  VARCHAR(500) NULL AFTER utm_campaign;

-- Backfill the 5 existing rows (only referer was ever populated
-- during dev — no UTM data to preserve). Safe to run against production.
UPDATE bookings
SET utm_source   = LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(attribution, '$.utmSource')))),
    utm_medium   = LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(attribution, '$.utmMedium')))),
    utm_campaign =       TRIM(JSON_UNQUOTE(JSON_EXTRACT(attribution, '$.utmCampaign'))),
    referer_url  = LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(attribution, '$.referer'))), 500)
WHERE attribution IS NOT NULL;

-- JSON_UNQUOTE on a NULL JSON value returns the string "null" — clean
-- that up so nulls stay nulls.
UPDATE bookings SET utm_source   = NULL WHERE utm_source   = 'null';
UPDATE bookings SET utm_medium   = NULL WHERE utm_medium   = 'null';
UPDATE bookings SET utm_campaign = NULL WHERE utm_campaign = 'null';
UPDATE bookings SET referer_url  = NULL WHERE referer_url  = 'null';

-- Now that data is on the flat columns, retire the JSON blob.
ALTER TABLE bookings
  DROP COLUMN attribution;

-- Index on utm_source for the most common reporting filter
-- ("bookings by channel"). Skipping compound indexes until the
-- reports endpoint proves what shape queries actually take.
ALTER TABLE bookings
  ADD KEY idx_utm_source (utm_source);
