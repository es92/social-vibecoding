-- #6534: the connector can send an HTML design ahead of a post_message, the
-- way it already sends a plan, a video or a screenshot. A design's bytes
-- wait in connector_uploads.data and post_message takes it as designUploadId.

ALTER TABLE connector_uploads DROP CONSTRAINT IF EXISTS connector_uploads_kind_check;
ALTER TABLE connector_uploads ADD CONSTRAINT connector_uploads_kind_check
  CHECK (kind IN ('plan', 'video', 'screenshot', 'design'));
