-- Files an app keeps for itself (narration, chapter text, generated data):
-- uploaded by the app's server with its app token alone, counted against
-- the app's allowance and never against a person's. `owner` says which
-- kind a row is; an app's file has no uploader, and a person's file keeps
-- `user` even after its uploader's account is gone (user_id SET NULL).
-- `sha256` is the uploaded bytes' digest, so an app can verify a copy;
-- rows stored before it stay null.
ALTER TABLE app_files
  ADD COLUMN IF NOT EXISTS owner VARCHAR(4) NOT NULL DEFAULT 'user';
ALTER TABLE app_files
  ADD COLUMN IF NOT EXISTS sha256 CHAR(64);

ALTER TABLE app_files DROP CONSTRAINT IF EXISTS app_files_owner_check;
ALTER TABLE app_files ADD CONSTRAINT app_files_owner_check
  CHECK (owner IN ('user', 'app') AND (owner = 'user' OR user_id IS NULL));

-- An app pages through its own files by id.
CREATE INDEX IF NOT EXISTS idx_app_files_app_owner
  ON app_files (app_id, owner, id) WHERE NOT staging;

-- An admin's per-app file allowance; NULL means the platform default
-- (services/app-files.js PER_APP_CAP).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS file_storage_cap_bytes BIGINT;
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_file_storage_cap_bytes_check;
ALTER TABLE apps ADD CONSTRAINT apps_file_storage_cap_bytes_check
  CHECK (file_storage_cap_bytes IS NULL OR file_storage_cap_bytes >= 0);
