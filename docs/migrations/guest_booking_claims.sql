-- Magic-link claim tokens for guest bookings.
--
-- POST /public/bookings issues a token (raw hex string emailed to the
-- customer, SHA-256 hash stored here). GET /public/bookings/claim?token=
-- hashes the incoming token and looks it up.
--
-- One claim row per booking — recreate on the rare case of a token
-- rotation via UPSERT on booking_id, or leave as INSERT and expect the
-- UNIQUE key to fail loudly (v1 just does INSERT — booking creation
-- always mints a fresh token).
--
-- token_hash stored (not raw) so a DB leak doesn't hand out valid
-- claim links. Same pattern as email_verification_tokens.

CREATE TABLE guest_booking_claims (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_id                BIGINT UNSIGNED NOT NULL,
  token_hash                VARCHAR(64)     NOT NULL,
  expires_at                DATETIME        NOT NULL,
  claimed_at                DATETIME        NULL,
  claimed_by_customer_id    BIGINT UNSIGNED NULL,
  created_at                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_booking (booking_id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_expires (expires_at),
  CONSTRAINT fk_claims_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
