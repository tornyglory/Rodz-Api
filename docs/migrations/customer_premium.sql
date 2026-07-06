ALTER TABLE customers ADD COLUMN is_premium tinyint(1) NOT NULL DEFAULT 0 AFTER state;
