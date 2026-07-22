-- Add the story_comment notification topic so story owners can mute
-- push notifications when someone comments on their story.
-- Same pattern as service_due, rego_expiring, booking, etc.

ALTER TABLE customer_notification_prefs
  ADD COLUMN story_comment TINYINT(1) NOT NULL DEFAULT 1 AFTER workshop_message;
