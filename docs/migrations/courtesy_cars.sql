CREATE TABLE courtesy_cars (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  rego       VARCHAR(20)               NOT NULL UNIQUE,
  make       VARCHAR(50)               NOT NULL,
  model      VARCHAR(50)               NOT NULL,
  year       SMALLINT                  NULL,
  color      VARCHAR(30)               NULL,
  status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  store_id   INT                       NULL REFERENCES stores(id) ON DELETE SET NULL,
  created_at TIMESTAMP                 DEFAULT NOW(),
  updated_at TIMESTAMP                 DEFAULT NOW() ON UPDATE NOW()
);

ALTER TABLE bookings
  ADD COLUMN courtesy_car_id          INT       NULL REFERENCES courtesy_cars(id) ON DELETE SET NULL,
  ADD COLUMN courtesy_car_due_back    DATE      NULL,
  ADD COLUMN courtesy_car_assigned_at TIMESTAMP NULL,
  ADD COLUMN courtesy_car_returned_at TIMESTAMP NULL;
