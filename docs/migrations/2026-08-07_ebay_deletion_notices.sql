-- Audit log for eBay Marketplace Account Deletion notices.
--
-- Required by eBay's Production API policy: apps that hold user data
-- linked to eBay accounts must accept + acknowledge deletion notices.
-- We don't currently store any user data linked to eBay user ids —
-- we only search public listings — so there's nothing to actually
-- delete on receipt. Still log every notice for audit + to prove the
-- endpoint is live if compliance is ever questioned.

CREATE TABLE IF NOT EXISTS ebay_deletion_notices (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id    VARCHAR(120)    NULL,
  event_date         DATETIME        NULL,
  publish_date       DATETIME        NULL,
  ebay_username      VARCHAR(120)    NULL,
  ebay_user_id       VARCHAR(120)    NULL,
  eias_token         VARCHAR(500)    NULL,
  raw_payload        JSON            NOT NULL,
  received_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action_taken       ENUM('none','logged_only','user_data_deleted') NOT NULL DEFAULT 'logged_only',
  KEY idx_received (received_at DESC),
  KEY idx_ebay_user (ebay_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
