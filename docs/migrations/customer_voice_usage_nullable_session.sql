-- The TTS endpoint isn't session-scoped (POST /c/chat/tts takes only text,
-- no vehicle/session ownership implication). Allow NULL session_id so
-- usage can be recorded without pinning to a chat session.

ALTER TABLE customer_voice_usage
  DROP FOREIGN KEY fk_voice_usage_session;

ALTER TABLE customer_voice_usage
  MODIFY session_id BIGINT UNSIGNED NULL;

ALTER TABLE customer_voice_usage
  ADD CONSTRAINT fk_voice_usage_session
  FOREIGN KEY (session_id) REFERENCES customer_chat_sessions(id) ON DELETE SET NULL;

-- Add 'tts' so Polly rows can be distinguished from Gemini Live session rows.
ALTER TABLE customer_voice_usage
  MODIFY ended_reason ENUM('user_hangup','timeout','error','interrupted','tts') NOT NULL;
