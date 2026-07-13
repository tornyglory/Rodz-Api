-- Chat messages are now stored in S3 as one blob per session
-- (diagnostic-sessions/current/{sessionId}.json). MySQL only keeps session
-- metadata in customer_chat_sessions.
--
-- Existing rows were migrated to S3 via scripts/migrate-chats-to-s3.mjs.

DROP TABLE customer_vehicle_chats;
