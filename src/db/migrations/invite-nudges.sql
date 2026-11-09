-- The bring-a-friend nudge (src/services/invite-nudge.js): Homeroom bot asks
-- somebody new to a project, once, after the first thing they did there, to
-- invite one or two friends to it.
--
-- One row per person and project, ever: the UNIQUE key is the "once", and
-- the row is written (claimed) before the message is sent, so a send that
-- never happens still asks nothing again. `created_at` is also what the
-- one-a-week cap counts across every project. `act` is the first thing they
-- did there, which the message names. `card_id` is the message's bot card
-- (bot_cards, kind 'invite_friends'), whose Not now is the dismissal:
-- `dismissed_at`.

CREATE TABLE IF NOT EXISTS invite_nudges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  act VARCHAR(16) NOT NULL CHECK (act IN ('vote', 'message', 'request', 'change', 'app')),
  card_id INTEGER REFERENCES bot_cards(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  UNIQUE (user_id, app_id)
);

COMMENT ON TABLE invite_nudges IS 'staging:private';

-- The nudge's Not now is a bot card like any other offer in the chat. The
-- list is the one before it (change-pictures: run_shots, post_pictures_plan)
-- with invite_friends added.
ALTER TABLE bot_cards DROP CONSTRAINT IF EXISTS bot_cards_kind_check;
ALTER TABLE bot_cards ADD CONSTRAINT bot_cards_kind_check
  CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request', 'post_reply',
                  'post_design', 'copy_request', 'file_many', 'withdraw_change', 'try_again', 'overlap',
                  'run_shots', 'post_pictures_plan', 'invite_friends'));
