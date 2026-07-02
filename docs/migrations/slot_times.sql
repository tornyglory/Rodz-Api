-- Add block_times to stores table
-- NULL = use system default ["08:00","10:00","13:00","15:00"]
ALTER TABLE stores
  ADD COLUMN block_times JSON NULL
  AFTER timezone;
