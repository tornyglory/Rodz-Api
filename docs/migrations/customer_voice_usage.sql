-- Voice-mode daily usage tracking for Gold-tier customers.
-- Each row = one completed voice session's active audio time.
-- The daily quota check in POST /voice/token sums today's rows for the customer.

CREATE TABLE customer_voice_usage (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED NOT NULL,
  session_id    BIGINT UNSIGNED NOT NULL,
  seconds       INT UNSIGNED    NOT NULL DEFAULT 0,
  ended_reason  ENUM('user_hangup','timeout','error','interrupted') NOT NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_customer_created (customer_id, created_at),
  CONSTRAINT fk_voice_usage_customer FOREIGN KEY (customer_id) REFERENCES customers(id)              ON DELETE CASCADE,
  CONSTRAINT fk_voice_usage_session  FOREIGN KEY (session_id)  REFERENCES customer_chat_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Daily quota check (used by POST /voice/token):
--   SELECT COALESCE(SUM(seconds), 0) AS used_today
--   FROM   customer_voice_usage
--   WHERE  customer_id = ? AND created_at >= CURDATE();
