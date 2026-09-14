'use strict';

/**
 * Manifest-editing PR creation — PRs that change a single dapp.json
 * field and drop straight into the vote panel as a `promoted`
 * chat_sessions row with full promote-path parity (promoted_at,
 * pr_promoted analytics event, pr_proposed voter-nudge notifications,
 * group-chat vote message).
 *
 * The flavors share the createManifestPR core so they can never drift:
 *   - rename PRs (top-level `name`) — used by the interactive route
 *     (POST /api/apps/:slug/rename in routes/apps.js) and the one-time
 *     boot migration that drains the legacy rename-issue backlog
 *     (migrateOpenRenameIssues below);
 *   - visibility PRs (top-level `visibility` block, issue #124) — used
 *     by POST /api/apps/:slug/visibility-pr in routes/apps.js. The
 *     change applies when the merged PR's production rebuild runs
 *     appManifest.reconcileAppVisibility;
 *   - governance PRs (top-level `governance` block, issue #646) — used
 *     by POST /api/apps/:slug/governance-pr; applied by
 *     reconcileAppGovernance (or seedSelfApp for the self-app);
 *   - admins PRs (top-level `admins` array, issue #788) — used by
 *     POST /api/apps/:slug/admins-pr; applied by reconcileAppAdmins.
 *     These carry explicitApproval: true, so the resulting proposal
 *     never merges on a timer and can't be force-merged by an app
 *     admin (see services/app-admins.js).
 */

const log = require('./logger');
const github = require('./github');
const appManifest = require('./app-manifest');
const events = require('./events');

function renamePrTitle(newName) {
  return `Rename to "${newName}"`;
}

/**
 * Shared core: open a PR that edits dapp.json via `opts.mutate` and drop
 * it into the vote panel as a `promoted` session. The caller owns
 * user-facing validation and dedupe; this helper assumes it's been
 * cleared to proceed.
 *
 * `actor` is `{ id, username }` — the user attributed as the proposer.
 * `id` may be null (e.g. a deleted issue author).
 *
 * `opts`:
 *   - mutate(manifestObj)  — applies the field change in place;
 *   - branchPrefix         — 'rename' | 'visibility';
 *   - commitMessage, prTitle, prBody;
 *   - chatText(prData, majority, activeUsers) — group-chat vote message;
 *   - eventMetadata        — extra pr_promoted metadata (prNumber is
 *                            added automatically);
 *   - explicitApproval     — true when the mutation touches a
 *                            privilege-granting block (#788, today the
 *                            top-level `admins` list), which switches
 *                            off the time-based merge paths for the
 *                            resulting proposal. Defaults to false.
 *
 * Throws on GitHub / DB failure so callers can map it to an HTTP error
 * or skip-and-continue. On success returns
 * `{ sessionId, prNumber, prUrl, branch }`.
 */
async function createManifestPR(config, pool, app, actor, opts) {
  const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) throw new Error('Could not parse the app repository URL');

  // Build the updated dapp.json. Preserve existing fields when the file
  // is present + parseable; create a minimal manifest when it's missing
  // (legacy apps predating the manifest). A malformed file is already
  // treated as empty by the deploy reader, so falling back to a fresh
  // object there is safe.
  let manifestObj = { secrets: [] };
  const existing = await github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, 'main');
  if (existing != null) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifestObj = parsed;
    } catch {
      log.warn('rename-pr', 'Existing dapp.json unparseable; writing fresh manifest', { slug: app.slug });
    }
  }
  opts.mutate(manifestObj);
  const updatedContent = `${JSON.stringify(manifestObj, null, 2)}\n`;

  // Branch naming pattern: <prefix>/<slug>-<timestamp>. The timestamp
  // suffix avoids collisions if a prior attempt left a stale branch on
  // the remote. (Plain service code, not a workflow script, so Date.now
  // is fine here.)
  const branch = `${opts.branchPrefix}/${app.slug}-${Date.now()}`;
  await github.createBranch(owner, repo, branch);
  await github.pushFiles(
    owner, repo,
    [{ path: appManifest.MANIFEST_FILENAME, content: updatedContent }],
    { branch, message: opts.commitMessage }
  );

  const prTitle = opts.prTitle;
  // safeMention is applied inside github.createPR; the actor.username
  // and names flow into the body verbatim here.
  const prData = await github.createPR(owner, repo, { branch, title: prTitle, body: opts.prBody });

  // Drop the rename PR straight into the vote panel as a promoted
  // session, mirroring the normal promote path (POST
  // /api/sessions/:id/promote in routes/votes.js): set promoted_at
  // (anchors the stale-PR sweeper), emit pr_promoted, fan out
  // pr_proposed notifications.
  const { rows: sessRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, promoted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', NOW())
     RETURNING id`,
    [app.id, actor.id || null, branch, prData.number, prData.html_url, prTitle]
  );
  const sessionId = sessRows[0].id;

  // #788: stamp the explicit-approval flag directly. We KNOW what this
  // PR mutates (opts.explicitApproval is set by the caller that built
  // the mutation), so there's no need to round-trip GitHub to diff a
  // file we just wrote — and stamping at creation is what makes the
  // highest-risk path (a platform-opened admins PR) correct even if
  // GitHub is unreachable at merge time.
  await pool.query(
    `UPDATE chat_sessions
        SET requires_explicit_approval = $2, explicit_approval_reason = $3
      WHERE id = $1`,
    [sessionId, !!opts.explicitApproval, opts.explicitApproval ? 'admins' : null]
  ).catch((err) => log.warn('rename-pr', 'Explicit-approval stamp failed', {
    sessionId, err: err.message,
  }));

  const { sendSystemMessage, pushVoteUpdate, pushNotificationToUser } = require('./ws');
  const notifications = require('./notifications');
  const { getActiveUserStats } = require('./active-users');
  const { active: activeUsers, majority } = await getActiveUserStats(pool, app.id);

  await sendSystemMessage(pool, app.id,
    opts.chatText(prData, majority, activeUsers),
    'vote',
    { vote: { sessionId, prNumber: prData.number } }
  ).catch((err) => log.warn('rename-pr', 'Manifest-PR chat msg failed', { err: err.message }));

  pushVoteUpdate({ sessionId, appSlug: app.slug, merged: false });

  // pr_promoted is the funnel stage the PR-promotion analytics read;
  // emit it so manifest PRs count like every other promoted PR.
  events.record(pool, {
    type: events.EVENT_TYPES.PR_PROMOTED,
    userId: actor.id || null,
    appId: app.id,
    sessionId,
    metadata: { prNumber: prData.number, ...(opts.eventMetadata || {}) },
  });

  // Vote-request fan-out — same as the normal promote path. Non-fatal:
  // the rename PR is already open, so a notification hiccup must not
  // poison the result.
  try {
    const notifRows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id,
      sessionId,
      proposerId: actor.id || null,
    });
    for (const row of notifRows) {
      pushNotificationToUser(row.user_id, {
        type: 'notification_new',
        notification: notifications.serialize({
          ...row,
          app_slug: app.slug,
          app_name: app.name,
          pr_title: prTitle,
          pr_number: prData.number,
          source_username: actor.username,
        }),
      });
    }
    if (notifRows.length) {
      log.info('rename-pr', 'Manifest-PR pr_proposed notifications sent', {
        sessionId, count: notifRows.length,
      });
    }
  } catch (err) {
    log.warn('rename-pr', 'Manifest-PR pr_proposed notify failed', { sessionId, err: err.message });
  }

  log.info('rename-pr', 'Manifest PR opened', {
    slug: app.slug, prNumber: prData.number, title: prTitle, by: actor.username,
  });

  return { sessionId, prNumber: prData.number, prUrl: prData.html_url, branch };
}

/**
 * Open a rename PR for `app` targeting `newName` — a manifest PR that
 * sets dapp.json's top-level `name`. Caller owns validation (length,
 * name-differs, GitHub-enabled) and dedupe.
 */
async function createRenamePR(config, pool, app, newName, actor) {
  return createManifestPR(config, pool, app, actor, {
    mutate: (m) => { m.name = newName; },
    branchPrefix: 'rename',
    commitMessage: `Rename to "${newName}"`,
    prTitle: renamePrTitle(newName),
    prBody:
      `${actor.username} (via Homeroom) proposed renaming "${app.name}" to "${newName}".\n\n` +
      `This PR updates the \`name\` field in \`dapp.json\`. It still needs a regular ` +
      `merge vote to land. Vote in the app's group chat panel. The new name applies ` +
      `automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed renaming to "${newName}". Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { rename: true },
  });
}

function visibilityPrTitle(collab, view) {
  return `Make this app ${appManifest.describeVisibility(collab, view)}`;
}

/**
 * Open a visibility-change PR for `app` (issue #124) — a manifest PR
 * that sets dapp.json's top-level `visibility` block to
 * `{ build: collab, view }`. Caller owns validation (combo invariant,
 * differs-from-current, creator/admin gate, GitHub-enabled) and dedupe
 * (findVisibilityPr below). The change applies when the merged PR's
 * production rebuild runs reconcileAppVisibility.
 */
async function createVisibilityPR(config, pool, app, { collab, view }, actor) {
  const desc = appManifest.describeVisibility(collab, view);
  return createManifestPR(config, pool, app, actor, {
    mutate: (m) => { m.visibility = { build: collab, view }; },
    branchPrefix: 'visibility',
    commitMessage: visibilityPrTitle(collab, view),
    prTitle: visibilityPrTitle(collab, view),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}" to be ${desc}.\n\n` +
      `This PR updates the \`visibility\` block in \`dapp.json\` (\`build\` = who can ` +
      `build the app, \`view\` = who can see & use it). It still needs a regular merge ` +
      `vote to land. Vote in the app's group chat panel. The new visibility applies ` +
      `automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed making this app ${desc}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { visibility: true },
  });
}

function governancePrTitle(policy, approvalsRequired) {
  return `Change proposal approvals: ${appManifest.describeGovernance(policy, approvalsRequired)}`;
}

/**
 * Open a governance-change PR for `app` (issue #646) — a manifest PR
 * that sets dapp.json's top-level `governance` block to
 * `{ approvers: policy, approvals: 'default' | { atLeast: N } }`.
 * Caller owns validation (value set, differs-from-current,
 * creator/admin gate, GitHub-enabled) and dedupe (findGovernancePr
 * below). The change applies when the merged PR's production rebuild
 * runs reconcileAppGovernance — or, for the self-hosted platform app,
 * on the post-deploy boot's seedSelfApp reconcile.
 */
async function createGovernancePR(config, pool, app, { policy, approvalsRequired }, actor) {
  const desc = appManifest.describeGovernance(policy, approvalsRequired);
  return createManifestPR(config, pool, app, actor, {
    mutate: (m) => {
      m.governance = {
        approvers: policy,
        approvals: approvalsRequired != null ? { atLeast: approvalsRequired } : 'default',
      };
    },
    branchPrefix: 'governance',
    commitMessage: governancePrTitle(policy, approvalsRequired),
    prTitle: governancePrTitle(policy, approvalsRequired),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}"'s proposal-approval ` +
      `settings to ${desc}.\n\n` +
      `This PR updates the \`governance\` block in \`dapp.json\` (\`approvers\` = who can ` +
      `approve proposals, \`approvals\` = how many approvals are needed). It still needs a ` +
      `regular merge vote to land. Vote in the app's group chat panel. The new settings ` +
      `apply automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed changing proposal approvals to ${desc}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { governance: true },
  });
}

function adminsPrTitle(usernames) {
  return `Change app admins: ${appManifest.describeAdmins(usernames)}`;
}

/**
 * Open an app-admins change PR for `app` (issue #788) — a manifest PR
 * that sets dapp.json's top-level `admins` array to `usernames`
 * (display-cased, deduped; an empty array is how the roster is
 * cleared). Caller owns validation (entry shape, cap, normalized
 * differs-from-current, creator/app-admin gate, NOT self-hosted,
 * GitHub-enabled) and dedupe (findAdminsPr below). The change applies
 * when the merged PR's production rebuild runs reconcileAppAdmins.
 *
 * Passes explicitApproval: true — the resulting proposal grants
 * app-level power, so the time-based merge paths are off and only a
 * platform admin can force-merge it (services/governance.js
 * applyNoTimerMerge + services/app-admins.js canForceMerge).
 */
async function createAdminsPR(config, pool, app, { usernames }, actor) {
  const desc = appManifest.describeAdmins(usernames);
  return createManifestPR(config, pool, app, actor, {
    mutate: (m) => { m.admins = usernames; },
    branchPrefix: 'admins',
    commitMessage: adminsPrTitle(usernames),
    prTitle: adminsPrTitle(usernames),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}"'s app admins ` +
      `to ${desc}.\n\n` +
      `This PR updates the \`admins\` array in \`dapp.json\`: the platform users who can ` +
      `administer this app (creator-level settings plus force-merging its proposals). ` +
      `Because it grants app-level power, the time-based merge paths are switched off for ` +
      `this proposal: it merges only when the app's normal vote threshold is met by Yes ` +
      `votes people actually cast, and only a platform admin (never an app admin) can ` +
      `force-merge it. The new roster applies automatically once the PR merges and the ` +
      `app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed changing this app's admins to ${desc}. Opened PR ` +
      `#${prData.number}: it needs real Yes votes (${majority}/${activeUsers}) and won't ` +
      `merge on a timer.`,
    eventMetadata: { admins: true },
    explicitApproval: true,
  });
}

function secretDeclarationPrTitle(scope, key) {
  return scope === 'platform'
    ? `Declare platform variable "${key}"`
    : `Declare app secret "${key}"`;
}

/**
 * Open a secret-DECLARATION PR — a manifest PR that appends one entry to
 * dapp.json's `secrets` array (a child app) or `platform_env` array (the
 * self-hosted platform).
 *
 * This is the manifest half of "add a brand-new variable from the App
 * secrets panel". The VALUE half rides on the same proposal via
 * services/pending-secrets.js (held encrypted until the merge) or, for a
 * full admin, was already written directly to the value store. The PR
 * body therefore says whether a value accompanies the proposal — but
 * NEVER the value itself, since a PR body is public repo content.
 *
 * `declaration` is a services/pending-secrets.normalizeDeclaration()
 * result: { description, required, private, default, staging_default,
 * group }. Only the fields meaningful for the scope are written —
 * `staging_default` is app-only (nothing in platform_env is injected into
 * a container, so a staging fallback would be meaningless) and `group` is
 * platform-only (the `secrets` reader has no group).
 *
 * Caller owns validation (key shape, reserved/unwritable keys, collision
 * against the manifest + value store + pending rows, field caps,
 * GitHub-enabled) and dedupe (findSecretDeclarationPr below).
 */
async function createSecretDeclarationPR(config, pool, app, { scope, key, declaration, hasValue }, actor) {
  const isPlatform = scope === 'platform';
  const decl = declaration || {};
  const title = secretDeclarationPrTitle(scope, key);

  // Field order matches how the manifest reader documents each block, so
  // a hand-written entry and a platform-written one look the same.
  const entry = isPlatform
    ? { key, group: decl.group || 'General' }
    : { key };
  if (decl.description) entry.description = decl.description;
  if (decl.required) entry.required = true;
  if (decl.private) entry.private = true;
  if (decl.default != null) entry.default = decl.default;
  if (!isPlatform && decl.staging_default != null) entry.staging_default = decl.staging_default;

  const flagBits = [
    decl.required ? '`required: true` (deploys block until it has a value)' : '`required: false`',
    decl.private ? '`private: true` (encrypted at rest, never returned by the API, not propagated into staging)' : '`private: false`',
  ];
  if (decl.default != null) {
    flagBits.push(isPlatform
      ? `\`default: "${decl.default}"\` (documentation of the committed fallback; the platform's deploy stays authoritative)`
      : `\`default: "${decl.default}"\` (used when no value is stored)`);
  }
  if (!isPlatform && decl.staging_default != null) {
    flagBits.push(`\`staging_default: "${decl.staging_default}"\` (what PR previews use)`);
  }

  const valueLine = hasValue
    ? 'A value for it is part of this proposal and is applied when this PR merges. '
      + 'The value itself is deliberately not in this PR: it is stored encrypted by the platform.'
    : 'No value accompanies this proposal: it declares the variable only.';

  return createManifestPR(config, pool, app, actor, {
    mutate: (m) => {
      const field = isPlatform ? 'platform_env' : 'secrets';
      if (!Array.isArray(m[field])) m[field] = [];
      // Replace rather than duplicate if the key somehow already exists
      // on main (the route's collision check reads the manifest SNAPSHOT,
      // which lags a dev-session edit that merged but hasn't deployed).
      const at = m[field].findIndex((e) => e && e.key === key);
      if (at >= 0) m[field][at] = entry;
      else m[field].push(entry);
    },
    branchPrefix: 'secret-declare',
    commitMessage: title,
    prTitle: title,
    prBody:
      `${actor.username} (via Homeroom) proposed declaring ${isPlatform ? 'a new platform variable' : 'a new app secret'} `
      + `\`${key}\`${decl.description ? `: ${decl.description}` : ''}.\n\n`
      + `This PR appends one entry to the \`${isPlatform ? 'platform_env' : 'secrets'}\` array in \`dapp.json\`:\n`
      + `${flagBits.map((b) => `- ${b}`).join('\n')}\n\n`
      + `${valueLine}\n\n`
      + `It still needs a regular merge vote to land. Vote in the app's group chat panel. `
      + (isPlatform
        ? 'Once merged, the declaration is picked up on the platform\'s next deploy, which is also when the value reaches the platform process.'
        : 'Once merged, the value is stored and the app redeploys with the new variable in its environment.'),
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed adding the ${isPlatform ? 'platform variable' : 'app secret'} ${key}`
      + `${hasValue ? ' (value included)' : ''}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { secretDeclaration: true, scope, key },
    explicitApproval: false,
  });
}

// Returns the open declaration PR session for one key, if any — the
// dedupe check for POST /api/apps/:slug/secret-declaration-pr. Scoped to
// the key (unlike visibility/governance/admins, which allow one proposal
// of their kind per app): two people declaring two different variables at
// once is perfectly reasonable.
async function findSecretDeclarationPr(pool, appId, scope, key) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'secret-declare/%'
        AND pr_title = $2
      ORDER BY id DESC
      LIMIT 1`,
    [appId, secretDeclarationPrTitle(scope, key)]
  );
  return rows[0] || null;
}

// Returns the open admins-change PR session for an app, if any — the
// dedupe check for POST /api/apps/:slug/admins-pr (one admins proposal
// in flight per app, like visibility/governance), and the
// `openProposal` pointer GET /api/apps/:slug/admins returns so the
// Members panel can show the "already up for vote" state.
async function findAdminsPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'admins/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Returns the open governance-change PR session for an app, if any —
// the dedupe check for POST /api/apps/:slug/governance-pr (one
// governance proposal in flight per app, like visibility).
async function findGovernancePr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'governance/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Returns the open visibility-change PR session for an app, if any —
// the dedupe check for POST /api/apps/:slug/visibility-pr (only one
// visibility proposal is allowed in flight per app, unlike renames
// which dedupe per target name).
async function findVisibilityPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'visibility/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Returns a matching rename PR session for the same target name. Used by
// the migration to stay idempotent without collapsing distinct legacy
// rename proposals for the same app into one PR.
async function findRenamePrForName(pool, appId, newName) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'rename/%'
        AND pr_title = $2
      ORDER BY id DESC
      LIMIT 1`,
    [appId, renamePrTitle(newName)]
  );
  return rows[0] || null;
}

// Carries the issue's votes onto the rename PR so people do not have to vote
// the same thing twice.
//
// approval_epoch is not named here on purpose: schema.sql's
// pr_votes_stamp_approval_epoch trigger fills it from the session. It was
// named nowhere at all once (#2050), and since NULL never equals the
// session's epoch, every vote this carried across arrived already dead.
async function restoreIssueVotesToPr(pool, issueId, sessionId) {
  const { rowCount } = await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       SELECT $2, iv.user_id,
              CASE iv.vote WHEN 'up' THEN 'yes' WHEN 'down' THEN 'no' END,
              iv.created_at
         FROM issue_votes iv
        WHERE iv.issue_id = $1
          AND iv.vote IN ('up', 'down')
      ON CONFLICT (session_id, user_id) DO NOTHING`,
    [issueId, sessionId]
  );
  return rowCount;
}

/**
 * One-time, idempotent boot routine: convert every open `issues` row with
 * kind='rename' into an equivalent rename PR (via createRenamePR), then
 * best-effort close the GitHub issue + close the DB issue row so the
 * legacy backlog drains and repos' issue trackers stay clean.
 *
 * Idempotency: a rename issue whose exact target name already has an open
 * rename PR is not re-opened; its old issue votes are copied onto that PR.
 * Distinct rename issues for the same app still become distinct PRs so the
 * vote surface preserves all in-flight proposals. A single failing app
 * (GitHub disabled, no bot access, unparseable repo) logs and continues
 * rather than aborting the batch. No-op when GitHub isn't configured.
 */
async function migrateOpenRenameIssues(config, pool) {
  if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
    log.info('rename-pr', 'Skipping rename-issue migration (GitHub not configured)');
    return { migrated: 0, skipped: 0 };
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT i.id, i.app_id, i.github_issue_number, i.payload,
              a.slug, a.name, a.repo_url,
              u.username AS created_by_username, i.created_by
         FROM issues i
         JOIN apps a ON a.id = i.app_id
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.kind = 'rename' AND i.status = 'open'`
    ));
  } catch (err) {
    // issues table or columns missing on a fresh DB — nothing to migrate.
    log.warn('rename-pr', 'Could not query open rename issues (skipping)', { err: err.message });
    return { migrated: 0, skipped: 0 };
  }
  if (!rows.length) return { migrated: 0, skipped: 0 };

  log.info('rename-pr', 'Migrating open rename issues to rename PRs', { count: rows.length });
  let migrated = 0;
  let skipped = 0;

  for (const issue of rows) {
    try {
      const newName = typeof issue.payload?.newName === 'string' ? issue.payload.newName.trim() : '';
      if (!newName || newName.length > appManifest.MAX_APP_NAME_LENGTH) {
        log.warn('rename-pr', 'Skipping rename issue with invalid newName', { issueId: issue.id });
        skipped++;
        continue;
      }
      const [, owner, repo] = (issue.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!owner || !repo) {
        log.warn('rename-pr', 'Skipping rename issue (no parseable repo_url)', {
          issueId: issue.id, slug: issue.slug,
        });
        skipped++;
        continue;
      }

      const app = { id: issue.app_id, slug: issue.slug, name: issue.name, repo_url: issue.repo_url };
      const actor = { id: issue.created_by || null, username: issue.created_by_username || 'Homeroom' };

      const alreadyNamed = newName.toLowerCase() === (issue.name || '').toLowerCase();
      let renameSession = alreadyNamed ? null : await findRenamePrForName(pool, issue.app_id, newName);

      if (!alreadyNamed && !renameSession) {
        renameSession = await createRenamePR(config, pool, app, newName, actor);
        migrated++;
      } else {
        // Nothing new to open (name already applied, or this exact target
        // rename PR is already in flight) — just drain this lingering issue
        // row below after restoring its votes when a PR exists.
        log.info('rename-pr', 'Rename PR already open / name already applied; draining issue only', {
          issueId: issue.id, slug: issue.slug, alreadyNamed,
          existingSessionId: renameSession?.sessionId || renameSession?.id || null,
        });
        skipped++;
      }

      const sessionId = renameSession?.sessionId || renameSession?.id || null;
      const prNumber = renameSession?.prNumber || renameSession?.pr_number || null;
      if (sessionId) {
        const copiedVotes = await restoreIssueVotesToPr(pool, issue.id, sessionId);
        if (copiedVotes > 0) {
          log.info('rename-pr', 'Restored issue votes to rename PR', {
            issueId: issue.id, sessionId, copiedVotes,
          });
        }
      }

      // Best-effort: close the GitHub issue + close the DB row so it leaves
      // the app's open-issues list. Failures don't undo the PR we opened.
      if (issue.github_issue_number) {
        await github.closeIssue(owner, repo, issue.github_issue_number).catch((err) =>
          log.warn('rename-pr', 'GitHub issue close failed during migration', {
            issue: issue.github_issue_number, err: err.message,
          }));
      }
      await pool.query(
        `UPDATE issues SET status = 'closed',
            payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
          WHERE id = $1 AND status = 'open'`,
        [issue.id, JSON.stringify({
          migratedToPrAt: new Date().toISOString(),
          ...(sessionId ? { migratedToPrSessionId: sessionId } : {}),
          ...(prNumber ? { migratedToPrNumber: prNumber } : {}),
        })]
      ).catch((err) => log.warn('rename-pr', 'Could not close migrated rename issue row', {
        issueId: issue.id, err: err.message,
      }));
    } catch (err) {
      // One app failing (GitHub disabled mid-run, lost bot access, branch
      // collision, etc.) must not abort the whole batch — leave its issue
      // as-is so a later boot can retry.
      log.warn('rename-pr', 'Rename-issue migration failed for one app; continuing', {
        issueId: issue.id, slug: issue.slug, err: err.message,
      });
      skipped++;
    }
  }

  log.info('rename-pr', 'Rename-issue migration complete', { migrated, skipped });
  return { migrated, skipped };
}

module.exports = {
  createRenamePR,
  createVisibilityPR,
  createGovernancePR,
  createAdminsPR,
  createSecretDeclarationPR,
  findSecretDeclarationPr,
  secretDeclarationPrTitle,
  findVisibilityPr,
  findGovernancePr,
  findAdminsPr,
  migrateOpenRenameIssues,
  findRenamePrForName,
  restoreIssueVotesToPr,
};
