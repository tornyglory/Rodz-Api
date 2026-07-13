-- Denormalise amount + category onto s3_event_index so per-vehicle summary
-- aggregation can be computed without fetching S3 objects. Nullable for
-- non-financial event types (diagnostic-sessions, warning-lights).

ALTER TABLE s3_event_index
  ADD COLUMN amount_aud DECIMAL(10,2) NULL AFTER summary,
  ADD COLUMN category   VARCHAR(30)   NULL AFTER amount_aud,
  ADD INDEX idx_vehicle_type_date (vehicle_id, event_type, event_date, amount_aud);
