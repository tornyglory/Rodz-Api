ALTER TABLE vehicles
  ADD COLUMN public_profile_settings JSON NULL DEFAULT NULL
  COMMENT 'Per-tab visibility on the public logbook profile. NULL = all visible. Keys: history, photos, chat.';
