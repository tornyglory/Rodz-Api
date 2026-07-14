-- Persist the customer's Rodz-voice preference across devices.
-- Frontend previously stored these in localStorage.
--
-- Both nullable + no default so we can distinguish "user explicitly chose"
-- from "user hasn't touched the setting". Frontend defaults voicePreference
-- to 'female' and voiceSpecificName to null (Auto) when neither is set.

ALTER TABLE customers
  ADD COLUMN voice_preference    ENUM('female', 'male') NULL DEFAULT NULL,
  ADD COLUMN voice_specific_name VARCHAR(120)           NULL DEFAULT NULL;
