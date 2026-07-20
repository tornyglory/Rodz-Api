-- Per-customer 👍 / 👎 on individual AI chat messages. Powers the "was
-- this reply useful?" feedback loop that drives prompt iteration and
-- eval-set curation.
--
-- Messages themselves live in S3 (see messagesStore.ts); this table only
-- holds the customer's opinion of a given message, keyed by the S3 message
-- id (e.g. '1783985109460-0-c04979').
--
-- Product notes for future readers:
--   - Only AI (`role='model'`) messages should be thumbable — enforced on
--     the frontend, not here. The DB doesn't need to know the role.
--   - Thumbing the same message twice → replaces the rating (idempotent
--     PUT semantics). Clearing sends null and deletes the row.
--   - `reason` is optional freetext for 👎 — we don't force it, but if
--     provided we capture it verbatim (up to 500 chars).
--   - `prompt_version` is optional but recommended: stamp the version of
--     the system prompt that produced the message so we can correlate
--     rating rate to specific prompt iterations later.

CREATE TABLE chat_message_feedback (
  id              BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id     BIGINT UNSIGNED       NOT NULL,
  vehicle_id      BIGINT UNSIGNED       NOT NULL,
  session_id      BIGINT UNSIGNED       NOT NULL,
  message_id      VARCHAR(80)           NOT NULL,       -- S3 message id
  rating          ENUM('up','down')     NOT NULL,
  reason          VARCHAR(500)          NULL,
  prompt_version  VARCHAR(40)           NULL,
  created_at      DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_customer_message (customer_id, message_id),
  KEY idx_session       (session_id, created_at),
  KEY idx_rating_date   (rating, created_at),
  KEY idx_prompt_rating (prompt_version, rating),
  CONSTRAINT fk_feedback_customer FOREIGN KEY (customer_id) REFERENCES customers(id)              ON DELETE CASCADE,
  CONSTRAINT fk_feedback_vehicle  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)               ON DELETE CASCADE,
  CONSTRAINT fk_feedback_session  FOREIGN KEY (session_id)  REFERENCES customer_chat_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
