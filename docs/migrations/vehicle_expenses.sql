-- Phase 6: Expense tracker
-- Run on the rodz database before deploying expense endpoints

CREATE TABLE vehicle_expenses (
  id                    bigint unsigned NOT NULL AUTO_INCREMENT,
  vehicle_id            bigint unsigned NOT NULL,
  customer_id           bigint unsigned NOT NULL,
  category              enum('fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other') NOT NULL,
  merchant_name         varchar(200)    NULL,
  merchant_suburb       varchar(100)    NULL,
  merchant_state        char(3)         NULL,
  amount_aud            decimal(10,2)   NULL,
  expense_date          date            NOT NULL,
  odometer_km           int unsigned    NULL,
  -- Fuel-specific
  fuel_type             enum('unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10') NULL,
  fuel_litres           decimal(8,3)    NULL,
  price_per_litre       decimal(6,3)    NULL,
  -- EV-specific
  ev_kwh                decimal(8,3)    NULL,
  price_per_kwh         decimal(6,3)    NULL,
  -- Image & extraction
  image_id              varchar(255)    NULL,
  extraction_status     enum('manual','extracted','failed') NOT NULL DEFAULT 'manual',
  ai_raw                json            NULL,
  -- Tax / business
  is_business_expense   tinyint(1)      NOT NULL DEFAULT 0,
  notes                 text            NULL,
  created_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle_date (vehicle_id, expense_date),
  KEY idx_customer (customer_id),
  FOREIGN KEY (vehicle_id)    REFERENCES vehicles(id),
  FOREIGN KEY (customer_id)   REFERENCES customers(id)
);

-- Phase 7: Fuel & charging price intelligence
CREATE TABLE fuel_station_prices (
  id              bigint unsigned NOT NULL AUTO_INCREMENT,
  expense_id      bigint unsigned NULL,
  customer_id     bigint unsigned NOT NULL,
  station_name    varchar(200)    NOT NULL,
  station_suburb  varchar(100)    NULL,
  station_state   char(3)         NULL,
  fuel_type       enum('unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10','ev_kwh') NOT NULL,
  price           decimal(6,3)    NOT NULL,
  price_unit      enum('per_litre','per_kwh') NOT NULL DEFAULT 'per_litre',
  image_id        varchar(255)    NULL,
  reported_at     datetime        NOT NULL,
  created_at      datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_station_fuel (station_name, station_suburb, fuel_type),
  KEY idx_reported (reported_at),
  KEY idx_suburb_fuel (station_suburb, station_state, fuel_type),
  FOREIGN KEY (expense_id)   REFERENCES vehicle_expenses(id) ON DELETE SET NULL,
  FOREIGN KEY (customer_id)  REFERENCES customers(id)
);
