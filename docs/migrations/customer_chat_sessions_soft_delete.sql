-- Soft-delete for chat sessions. Deleted sessions are hidden from the
-- customer's UI and the AI's recall tools, but the metadata row + the S3
-- blob (moved to diagnostic-sessions/archived/*.json) live on for training
-- data + potential future restore.

ALTER TABLE customer_chat_sessions
  ADD COLUMN deleted_at DATETIME NULL AFTER updated_at,
  ADD INDEX idx_vehicle_active (vehicle_id, deleted_at);
