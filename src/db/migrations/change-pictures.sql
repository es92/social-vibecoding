-- Show what a change looks like, emails included, in its thread (#6533).
-- A change's rendered emails, at its base and at its head, kept as media
-- objects (services/change-pictures.js): the card under Homeroom bot's reply
-- carries ids only, and the route serves the drawn email as JSON.

CREATE TABLE IF NOT EXISTS change_pictures (
  id          VARCHAR(32) PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  mail_kind   VARCHAR(64) NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('before', 'after')),
  is_new      BOOLEAN NOT NULL DEFAULT FALSE,
  subject     TEXT NOT NULL DEFAULT '',
  preheader   TEXT NOT NULL DEFAULT '',
  sha         CHAR(40) NOT NULL,
  object_key  TEXT NOT NULL REFERENCES media_objects(object_key),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, mail_kind, side, sha)
);
COMMENT ON TABLE change_pictures IS 'staging:private';
CREATE INDEX IF NOT EXISTS change_pictures_session_idx ON change_pictures (session_id, mail_kind, side);

-- The two offers a change's thread can now carry: take its missing shots,
-- and post the pictures it showed as a plan on its request.
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_kind_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request', 'file_many', 'withdraw_change', 'try_again', 'overlap',
                  'run_shots', 'post_pictures_plan'));
