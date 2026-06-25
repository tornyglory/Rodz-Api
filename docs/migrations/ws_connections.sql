CREATE TABLE IF NOT EXISTS ws_connections (
  connection_id VARCHAR(255) NOT NULL,
  staff_id      INT UNSIGNED NOT NULL,
  store_id      INT UNSIGNED NULL,        -- NULL = super_admin (receives all notifications)
  role          VARCHAR(50)  NOT NULL,
  connected_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME     NOT NULL,
  PRIMARY KEY (connection_id),
  INDEX idx_store_id (store_id),
  INDEX idx_expires_at (expires_at)
);
