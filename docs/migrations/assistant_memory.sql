-- Per-vehicle scratchpad the AI assistant can write to. Injected into future
-- chat/voice sessions so the assistant appears to remember prior conversations.
-- Scoped to vehicle_id (not customer) so memories transfer on vehicle sale.

CREATE TABLE assistant_memory (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id  BIGINT UNSIGNED NOT NULL,
  note        VARCHAR(500)    NOT NULL,
  source      ENUM('assistant','customer','system') NOT NULL DEFAULT 'assistant',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME        NULL,
  deleted_at  DATETIME        NULL,

  INDEX idx_vehicle_active (vehicle_id, deleted_at, expires_at),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
