-- Extend video_assets.context_type to include 'story' so stories can
-- attach videos via the existing R2 + post-process pipeline.
-- Story videos land at story-clips/{storyId}/{videoId}.mp4 in R2.

ALTER TABLE video_assets
  MODIFY context_type ENUM(
    'quote',
    'chat',
    'vehicle',
    'modification',
    'invoice',
    'story'
  ) NOT NULL;
