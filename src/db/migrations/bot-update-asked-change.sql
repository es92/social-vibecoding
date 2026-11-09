-- #6537: the Homeroom bot updates a change its author made in Claude Code or
-- Codex when the author (or an admin) asks it to, on that same change. Such a
-- change may answer no request, so an ask on it has no request number.
ALTER TABLE homeroom_bot_change_asks ALTER COLUMN issue_number DROP NOT NULL;

-- The update itself is a bot look of its own kind (services/
-- homeroom-bot-takeover.js), run by the bot-look machine: `session_id` is the
-- change it updates, `user_id` the person whose week pays for it (the
-- change's author), `asked_by` who asked, `head_sha` the commit it made and
-- `revised` whether it moved the change, which the limit on updates people
-- asked for counts (homeroom-bot-followup.js revisionCounts).
ALTER TABLE homeroom_bot_looks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'look';
ALTER TABLE homeroom_bot_looks DROP CONSTRAINT IF EXISTS homeroom_bot_looks_kind_check;
ALTER TABLE homeroom_bot_looks ADD CONSTRAINT homeroom_bot_looks_kind_check
  CHECK (kind IN ('look', 'update'));
ALTER TABLE homeroom_bot_looks ADD COLUMN IF NOT EXISTS asked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE homeroom_bot_looks ADD COLUMN IF NOT EXISTS head_sha TEXT;
ALTER TABLE homeroom_bot_looks ADD COLUMN IF NOT EXISTS revised BOOLEAN;

-- One look running per person, as before; an update is one running per
-- change instead, so a look of the author's never holds an update back.
DROP INDEX IF EXISTS homeroom_bot_looks_running_idx;
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_looks_running_look_idx
  ON homeroom_bot_looks (user_id) WHERE state = 'running' AND kind = 'look';
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_looks_running_update_idx
  ON homeroom_bot_looks (session_id) WHERE state = 'running' AND kind = 'update';
CREATE INDEX IF NOT EXISTS homeroom_bot_looks_update_session_idx
  ON homeroom_bot_looks (session_id) WHERE kind = 'update';
