-- Placed parts orders — tracks what the workshop has bought for a
-- booking, from which supplier, and where each order sits in the
-- pipeline (placed → shipped → arrived).
--
-- Records exist regardless of whether the order was placed via API
-- (future) or via a manual click-through purchase (current). Every
-- part the workshop pays for lives here so we can:
--   * show "3 of 5 parts ordered" on the booking
--   * flag late/missing parts (expected_delivery vs today)
--   * roll up per-booking parts spend for margin analysis

CREATE TABLE IF NOT EXISTS part_orders (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_id            BIGINT UNSIGNED NOT NULL,
  service_job_id        BIGINT UNSIGNED NULL,
  offering_id           BIGINT UNSIGNED NULL,       -- source snapshot; may be gone if snapshot rotates
  part_name_id          INT UNSIGNED    NOT NULL,
  supplier              ENUM('ebay','burson','repco','other') NOT NULL,
  marketplace           VARCHAR(40)     NULL,
  external_order_id     VARCHAR(120)    NULL,       -- eBay order #, Burson invoice ref, etc.
  external_order_url    VARCHAR(800)    NULL,
  item_title            VARCHAR(500)    NOT NULL,
  quantity              INT UNSIGNED    NOT NULL DEFAULT 1,
  price_paid_native     DECIMAL(10,2)   NOT NULL,
  currency              VARCHAR(10)     NOT NULL DEFAULT 'AUD',
  shipping_paid_native  DECIMAL(10,2)   NULL,
  total_paid_aud        DECIMAL(10,2)   NOT NULL,
  status                ENUM('placed','confirmed','shipped','arrived','cancelled','returned','not_arrived')
                          NOT NULL DEFAULT 'placed',
  expected_delivery     DATE            NULL,
  arrived_at            DATE            NULL,
  tracking_number       VARCHAR(120)    NULL,
  tracking_carrier      VARCHAR(60)     NULL,
  placed_by_staff_id    BIGINT UNSIGNED NOT NULL,
  placed_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes                 VARCHAR(500)    NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_booking        (booking_id),
  KEY idx_status_delivery (status, expected_delivery),
  KEY idx_placed_by       (placed_by_staff_id),
  CONSTRAINT fk_po_booking FOREIGN KEY (booking_id)   REFERENCES bookings(id)               ON DELETE CASCADE,
  CONSTRAINT fk_po_part    FOREIGN KEY (part_name_id) REFERENCES part_names(id)             ON DELETE RESTRICT,
  CONSTRAINT fk_po_offer   FOREIGN KEY (offering_id)  REFERENCES part_sourcing_offerings(id) ON DELETE SET NULL,
  CONSTRAINT fk_part_order_staff   FOREIGN KEY (placed_by_staff_id) REFERENCES staff(id)            ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
