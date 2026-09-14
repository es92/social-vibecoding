'use strict';

/* The user's default coding-agent backend — one writer, because the write
 * has an ordering constraint that is easy to get wrong and fails as a 500.
 *
 * `user_agent_preferences` carries a PARTIAL UNIQUE INDEX
 * (`user_agent_preferences_one_default`: one `is_default = TRUE` row per
 * user). So the other defaults have to be cleared BEFORE the upsert, not
 * after: `ON CONFLICT` fires only once the INSERT has already attempted a
 * second `is_default = TRUE` row, and the index rejects it first. There
 * were two hand-written copies of that dance in src/routes/credentials.js
 * when #1348 needed a third; this is the one.
 *
 * What reads it: resolveDefaultAgentPreference() in src/routes/sessions.js,
 * which validates the stored answer before applying it. Flag/beta policy
 * can still produce a named Claude fallback; a missing OpenRouter credential
 * is provisioned on the next real build action, and an operational failure
 * stops visibly instead of changing providers.
 *
 * `client` is a pool or a checked-out client. Pass a client to enlist in a
 * caller's transaction (the OpenRouter-revoke path does, so "clear Codex,
 * make Claude the default" cannot half-apply); pass the pool otherwise and
 * the two statements are independently atomic, which is sufficient — the
 * window between them holds NO default rather than two. An eligible resolver
 * that finds none prepares OpenRouter; an explicit Claude row still wins.
 */

// Make `backend` this user's default, carrying its model and effort.
async function setDefaultBackend(client, userId, { backend, model, reasoningEffort } = {}) {
  await client.query(
    `UPDATE user_agent_preferences SET is_default = FALSE
      WHERE user_id = $1 AND is_default = TRUE AND backend <> $2`,
    [userId, backend],
  );
  await client.query(
    `INSERT INTO user_agent_preferences
       (user_id, backend, model_id, reasoning_effort, is_default)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (user_id, backend) DO UPDATE SET
       model_id = EXCLUDED.model_id,
       reasoning_effort = EXCLUDED.reasoning_effort,
       is_default = TRUE,
       updated_at = NOW()`,
    [userId, backend, model || null, reasoningEffort || null],
  );
}

module.exports = { setDefaultBackend };
