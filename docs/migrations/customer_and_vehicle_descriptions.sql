-- Add owner-authored description text to customers and vehicles.
-- Surfaced on public vehicle profiles and in the ask-seller counterparty payload.
-- Written via existing PATCH /c/me and PATCH /c/vehicles/{id}; AI-enhanceable via new endpoints.

ALTER TABLE customers
  ADD COLUMN description TEXT NULL AFTER postcode;

ALTER TABLE vehicles
  ADD COLUMN description TEXT NULL AFTER country;
