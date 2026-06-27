CREATE TABLE IF NOT EXISTS staff_leave (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  staff_id    BIGINT UNSIGNED NOT NULL,
  type        ENUM('annual','sick','personal','long_service','unpaid') NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  days        DECIMAL(4,1) NOT NULL,
  notes       TEXT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
  KEY idx_staff_leave_staff (staff_id)
);
