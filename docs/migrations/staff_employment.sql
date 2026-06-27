ALTER TABLE staff
  ADD COLUMN employment_type       ENUM('full_time','part_time','casual','contractor') NOT NULL DEFAULT 'full_time',
  ADD COLUMN salary_type           ENUM('annual','hourly') NOT NULL DEFAULT 'annual',
  ADD COLUMN salary_amount         DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN super_rate            DECIMAL(4,2)  NOT NULL DEFAULT 11.50,
  ADD COLUMN weekly_hours          DECIMAL(4,1)  NOT NULL DEFAULT 38.0,
  ADD COLUMN annual_leave_days     INT           NOT NULL DEFAULT 20,
  ADD COLUMN employment_start_date DATE          NULL;
