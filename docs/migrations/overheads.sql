CREATE TABLE overheads (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id       TINYINT UNSIGNED NULL,
  category       ENUM('rent','utilities','insurance','equipment','marketing','subscriptions','other') NOT NULL,
  label          VARCHAR(100)     NOT NULL,
  monthly_amount DECIMAL(10,2)    NOT NULL,
  created_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
  INDEX idx_overheads_store (store_id)
);
