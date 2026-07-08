CREATE TABLE IF NOT EXISTS public_chat_rate_limits (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bucket_key   VARCHAR(128) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bucket_created (bucket_key, created_at),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
