'use strict';

/**
 * Fleet maintenance campaigns — the engine behind
 * issues.kind='maintenance_campaign' (#853's generalization).
 *
 * A campaign is a platform-level governance proposal on the self-hosted
 * app. Once its vote passes (or an admin force-applies it),
 * issues.maybeApplyMaintenanceCampaignProposal creates a
 * maintenance_campaigns row and hands it to runCampaign() here, which:
 *
 *   1. Seeds one maintenance_campaign_apps row per target app
 *      (repo_url set, not self-hosted, optional slug filter) —
 *      idempotent, so re-entry after a restart just continues.
 *   2. Walks the pending rows ONE AT A TIME. Per app it runs a bounded
 *      LLM tool loop (read_file / edit_file / write_file / skip_app /
 *      finish) against the app's repo via the GitHub API. This is
 *      deliberately NOT a worker session: workers are repo-scoped by
 *      design (one session-scoped credential per repo), whereas the
 *      platform process already holds the PAT and the LLM client —
 *      no container boot, no clone, and the first successful app's
 *      summary is carried forward so later apps stay consistent.
 *   3. On staged edits: branch + push + PR, then a plain `promoted`
 *      chat_sessions row with source='maintenance' (the exact
 *      createManifestPR pattern — no worker, votable like any
 *      proposal), and kicks staging checks immediately (the
 *      kickImportedChecks pattern). Checks run in parallel across the
 *      fleet while the loop moves on.
 *   4. Marks the campaign 'done' when no pending rows remain. Merging
 *      is per-app: each community can vote its PR through normally, or
 *      an admin drains everything green via mergeGreen() (dashboard's
 *      "Merge all green" → routes/campaigns.js).
 *
 * Restart story: campaign + per-app state live in the DB. On boot,
 * resumeRunningCampaigns() re-enters every campaign still 'running';
 * rows stuck in 'running' (killed mid-app) are reset to 'pending'
 * first. The in-process _running set prevents the vote handler, the
 * sweeper, and the boot resume from double-driving one campaign.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const log = require('./logger');
const github = require('./github');
const llm = require('./llm');

const PLATFORM_USERNAME = 'usernode-platform';
// Tool-call round-trips per app. Maintenance changes are small by
// definition (read a file or two, stage an edit or two, finish) — but a
// repo with several >100 KB files can legitimately need a handful of
// paged reads and searches before the first edit, so leave headroom.
// A loop that needs more than this is lost, not thorough.
const MAX_TOOL_ITERATIONS = 20;
// Truncation guard for read_file RESULTS only — edits still apply
// against the full content held in memory, so an old_string deep in a
// huge file keeps matching even when the model saw a truncated view.
//
// The window alone proved insufficient for campaign #1 (JWT switchover,
// 2026-07-31): the three apps whose server.js exceeded 100 KB
// (puzzlechain 350 KB, block-game 345 KB, number-guessing 125 KB) all
// exhausted the tool budget. Their JWT code sat in the visible first
// 100 KB, but the instructions said "find EVERY place" — and with no way
// to inspect the rest of the file, the model kept re-reading the same
// truncated view trying to confirm completeness and never called finish.
// Every sub-100 KB app succeeded. Hence `offset` on read_file (page
// through the remainder) and search_file (answer "every place?" in one
// bounded call).
const MAX_READ_RESULT_CHARS = 100 * 1024;
// search_file caps: enough to enumerate every JWT/auth touchpoint in the
// worst real repo without ever flooding the context.
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_LINE_CHARS = 300;
// Pause between merge-green merges: each one triggers a production
// rebuild, and stampeding docker builds helps nobody.
const MERGE_GREEN_DELAY_MS = 2000;

const _running = new Set();

function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

/**
 * The dedicated proposer for campaign PRs. Every proposal list JOINs
 * users on chat_sessions.user_id, so campaign proposals need a real row —
 * and attributing them to a person would misname 30+ proposal cards.
 * Random discarded password so the account can never log in (same
 * posture as the staging fixture users in db/migrate.js).
 */
async function ensurePlatformUser(pool) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [PLATFORM_USERNAME]
  );
  if (rows.length) return rows[0].id;
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const { rows: ins } = await pool.query(
    `INSERT INTO users (username, password, is_admin, can_create_apps)
     VALUES ($1, $2, FALSE, FALSE)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [PLATFORM_USERNAME, hash]
  );
  if (ins.length) return ins[0].id;
  const { rows: again } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [PLATFORM_USERNAME]
  );
  if (!again.length) throw new Error('Could not create the usernode-platform user');
  return again[0].id;
}

// ─── The per-app AI tool loop ────────────────────────────────────────

const CAMPAIGN_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the app repository (main branch, plus any edits you have already staged). Returns the file content, or "File not found." Start with server.js for backend changes and public/index.html for frontend ones. Large files are returned in windows: if the result says it was truncated, call read_file again with `offset` to continue, or use search_file to locate what you need.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path, e.g. "server.js"' },
        offset: { type: 'integer', description: 'Character offset to start reading from (default 0). Use the value suggested by a truncated read to page through a large file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_file',
    description: 'Find every occurrence of a literal string in one file (main branch, plus any edits you have already staged). Returns matching lines with line numbers. Use this to confirm you have found ALL relevant code in a file too large to read in one window (e.g. search server.js for "JWT_SECRET" or "jwt.verify").',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path, e.g. "server.js"' },
        query: { type: 'string', description: 'Literal text to search for (case-sensitive, not a regex)' },
      },
      required: ['path', 'query'],
    },
  },
  {
    name: 'edit_file',
    description: 'Stage a surgical edit: replace old_string with new_string in a file. old_string must match the current file content EXACTLY (including whitespace) and appear exactly once. Preferred over write_file for every change to an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Stage a full file write. Only for creating a NEW file or when the instructions genuinely require rewriting one; use edit_file for changes to existing files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'skip_app',
    description: 'Declare that this app does not need the campaign change (e.g. the code the instructions target is absent). Ends work on this app without opening a PR.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
  {
    name: 'finish',
    description: 'All edits for this app are staged — end work on this app. The summary should describe exactly what was changed and where; it is shown to reviewers and reused as guidance for the next app in the campaign.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
];

function campaignSystemPrompt(campaign, exemplarSummary) {
  let prompt = `You are executing a platform maintenance campaign across many apps on the Homeroom platform. Each app is a small Node.js/Express server with an HTML/JS frontend, in its own git repository. You work on ONE app at a time.

Campaign: ${campaign.title}

Operator instructions:
${campaign.instructions}

Rules:
- Make the minimal change the instructions describe. Do not refactor, reformat, or fix anything unrelated.
- Keep the app's existing code style.
- Never guess file contents — read a file before editing it.
- Every response must call at least one tool. End with finish (edits staged) or skip_app (change not applicable).`;
  if (exemplarSummary) {
    prompt += `\n\nFor consistency: a previous app in this campaign was handled like this —\n${exemplarSummary}`;
  }
  return prompt;
}

/**
 * Run the bounded tool loop for one app. Resolves to
 *   { files: Map<path, content>, summary }  — edits staged, or
 *   { skipped: true, reason }               — app doesn't need the change.
 * Throws on LLM/GitHub errors, truncation, or budget exhaustion —
 * the caller records those as state='failed' with the message.
 *
 * `onUsage(usage, servedModel)` is invoked per LLM call so the caller
 * can attribute spend.
 */
async function runAppChange({ campaign, app, exemplarSummary, onUsage }) {
  const repo = parseRepo(app.repo_url);
  if (!repo) throw new Error(`Unparseable repo_url: ${app.repo_url}`);

  const staged = new Map();   // path -> full staged content
  const original = new Map(); // path -> content on main (read cache; null = 404)

  const readCurrent = async (path) => {
    if (staged.has(path)) return staged.get(path);
    if (original.has(path)) return original.get(path);
    const content = await github.getFileContent(repo.owner, repo.repo, path, 'main');
    original.set(path, content);
    return content;
  };

  const resolveTool = async (tc) => {
    const input = tc.input || {};
    if (tc.name === 'read_file') {
      const content = await readCurrent(String(input.path || ''));
      if (content == null) return 'File not found.';
      const offset = Math.max(0, Number(input.offset) || 0);
      if (offset >= content.length && offset > 0) {
        return `[offset ${offset} is past the end of the file (${content.length} chars) — nothing more to read]`;
      }
      const window = content.slice(offset, offset + MAX_READ_RESULT_CHARS);
      const end = offset + window.length;
      if (end < content.length) {
        return `${window}\n…[showing chars ${offset}–${end} of ${content.length} — call read_file with offset=${end} for the next window, or search_file to locate text. edit_file matches against the full file.]`;
      }
      return offset > 0 ? `[chars ${offset}–${end} of ${content.length}]\n${window}` : window;
    }
    if (tc.name === 'search_file') {
      const query = String(input.query ?? '');
      if (!query) return 'Error: query is required.';
      const content = await readCurrent(String(input.path || ''));
      if (content == null) return 'File not found.';
      const matches = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) continue;
        matches.push(`line ${i + 1}: ${lines[i].slice(0, MAX_SEARCH_LINE_CHARS)}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          matches.push(`…[stopped at ${MAX_SEARCH_MATCHES} matches — narrow the query]`);
          break;
        }
      }
      if (!matches.length) return 'No matches.';
      return `${matches.length >= MAX_SEARCH_MATCHES ? matches.length - 1 : matches.length} match(es):\n${matches.join('\n')}`;
    }
    if (tc.name === 'edit_file') {
      const path = String(input.path || '');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (!oldStr) return 'Error: old_string is empty.';
      const current = await readCurrent(path);
      if (current == null) return `Error: ${path} does not exist — use write_file to create a new file.`;
      const first = current.indexOf(oldStr);
      if (first === -1) return 'Error: old_string not found in the current file content. Re-read the file and retry with an exact match.';
      if (current.indexOf(oldStr, first + 1) !== -1) return 'Error: old_string appears more than once — include more surrounding context to make it unique.';
      staged.set(path, current.slice(0, first) + newStr + current.slice(first + oldStr.length));
      return `Edit staged for ${path}.`;
    }
    if (tc.name === 'write_file') {
      const path = String(input.path || '');
      if (!path) return 'Error: path is required.';
      staged.set(path, String(input.content ?? ''));
      return `Write staged for ${path}.`;
    }
    return 'ok';
  };

  // Compact one-line-per-tool-call trace. Logged per turn and embedded
  // in the budget-exhaustion error so a failed run on the dashboard is
  // self-diagnosing instead of a black box (the puzzlechain retry on
  // 2026-07-31 failed identically pre- and post-#862 and we had no way
  // to tell what the model spent its 12 turns on).
  const trace = [];
  const describeToolCall = (tc) => {
    const input = tc.input || {};
    if (tc.name === 'read_file') {
      return `read_file(${input.path}${input.offset ? `@${input.offset}` : ''})`;
    }
    if (tc.name === 'search_file') return `search_file(${input.path} ${JSON.stringify(String(input.query ?? '').slice(0, 40))})`;
    if (tc.name === 'edit_file' || tc.name === 'write_file') return `${tc.name}(${input.path})`;
    return tc.name;
  };

  const messages = [{
    role: 'user',
    content: `App: "${app.name}" (slug ${app.slug}). Repository: ${app.repo_url}. Apply the campaign instructions to this app now.`,
  }];
  const systemPrompt = campaignSystemPrompt(campaign, exemplarSummary);
  let nudged = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const res = await llm.streamChat({
      messages,
      systemPrompt,
      tools: CAMPAIGN_TOOLS,
      telemetryContext: {
        appId: app.id,
        backend: 'helper',
        component: 'fleet_maintenance',
      },
    });
    if (onUsage && res.usage) {
      try { onUsage(res.usage, res.servedModel); } catch { /* accounting never fails the run */ }
    }

    if (!res.toolUses.length) {
      if (res.stopReason === 'max_tokens') {
        throw new Error('LLM response truncated (max_tokens) — the change may be too large for a maintenance campaign');
      }
      // The model answered in prose. One nudge back toward the tools;
      // a second prose-only turn is a hard failure, not a loop.
      trace.push('prose');
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'assistant', content: res.rawContent });
        messages.push({ role: 'user', content: 'Use the tools to make the change, or call skip_app / finish. Do not answer in prose.' });
        continue;
      }
      throw new Error('LLM ended without calling finish or skip_app');
    }

    // Resolve every tool call (Anthropic requires a tool_result per
    // tool_use even alongside a terminal tool), then honor terminals.
    const turnTools = res.toolUses.map(describeToolCall);
    trace.push(...turnTools);
    log.info('fleet-maintenance', 'Campaign tool turn', {
      campaignId: campaign.id, slug: app.slug, iter: iter + 1, tools: turnTools,
    });
    let terminal = null;
    const results = [];
    for (const tc of res.toolUses) {
      if (tc.name === 'skip_app') {
        // skip_app wins over finish if the model somehow emits both:
        // "doesn't need the change" is the more conservative claim.
        terminal = { skipped: true, reason: String(tc.input?.reason || 'not applicable') };
        results.push({ tool_use_id: tc.id, content: 'ok' });
      } else if (tc.name === 'finish') {
        if (!terminal) terminal = { finished: true, summary: String(tc.input?.summary || '') };
        results.push({ tool_use_id: tc.id, content: 'ok' });
      } else {
        results.push({ tool_use_id: tc.id, content: await resolveTool(tc) });
      }
    }

    if (terminal) {
      if (terminal.skipped) return { skipped: true, reason: terminal.reason };
      if (!staged.size) throw new Error('LLM called finish without staging any edits');
      return { files: staged, summary: terminal.summary };
    }

    messages.push({ role: 'assistant', content: res.rawContent });
    messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })),
    });
  }

  throw new Error(
    `Tool-call budget exhausted (${MAX_TOOL_ITERATIONS} iterations) without finish/skip_app. `
    + `Tool trace: ${trace.join(' → ') || '(none)'}`
  );
}

// ─── PR + proposal per app ───────────────────────────────────────────

/**
 * Branch + push + PR + promoted session row (source='maintenance') +
 * the promote-path side effects (group-chat vote message, vote-panel
 * push, pr_promoted event, pr_proposed notifications) — mirrors
 * rename-pr.js's createManifestPR so campaign proposals behave like
 * every other platform-opened proposal. Then kicks staging checks.
 */
async function openCampaignProposal({ config, pool, campaign, app, files, summary, platformUserId }) {
  const repo = parseRepo(app.repo_url);
  if (!repo) throw new Error(`Unparseable repo_url: ${app.repo_url}`);

  const branch = `maint/c${campaign.id}/${app.slug}-${Date.now()}`;
  await github.createBranch(repo.owner, repo.repo, branch);
  await github.pushFiles(
    repo.owner, repo.repo,
    Array.from(files.entries()).map(([path, content]) => ({ path, content })),
    { branch, message: `Maintenance: ${campaign.title}` }
  );

  const prTitle = String(campaign.title).slice(0, 250);
  const prBody =
    `Platform maintenance campaign #${campaign.id}: **${campaign.title}**\n\n` +
    `${summary || 'See campaign instructions.'}\n\n` +
    `This PR was opened automatically by the Homeroom platform after the campaign's ` +
    `governance vote passed. It merges like any proposal: through this app's own ` +
    `merge vote, or when a platform admin drains the campaign's green checks.`;
  const prData = await github.createPR(repo.owner, repo.repo, { branch, title: prTitle, body: prBody });

  const { rows: sessRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, promoted_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', NOW(), 'maintenance')
     RETURNING id`,
    [app.id, platformUserId, branch, prData.number, prData.html_url, prTitle]
  );
  const sessionId = sessRows[0].id;

  const { sendSystemMessage, pushVoteUpdate, pushNotificationToUser } = require('./ws');
  const notifications = require('./notifications');
  const events = require('./events');
  const { getActiveUserStats } = require('./active-users');
  const { active: activeUsers, majority } = await getActiveUserStats(pool, app.id);

  await sendSystemMessage(pool, app.id,
    `Platform maintenance: "${campaign.title}" opened PR #${prData.number}. ` +
    `Needs ${majority}/${activeUsers} votes to land (or a platform admin merges it once checks pass).`,
    'vote',
    { vote: { sessionId, prNumber: prData.number } }
  ).catch((err) => log.warn('fleet-maintenance', 'Campaign chat msg failed', { err: err.message }));

  pushVoteUpdate({ sessionId, appSlug: app.slug, merged: false });

  events.record(pool, {
    type: events.EVENT_TYPES.PR_PROMOTED,
    userId: platformUserId,
    appId: app.id,
    sessionId,
    metadata: { prNumber: prData.number, maintenanceCampaignId: campaign.id },
  });

  try {
    const notifRows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id,
      sessionId,
      proposerId: platformUserId,
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
          source_username: PLATFORM_USERNAME,
        }),
      });
    }
  } catch (err) {
    log.warn('fleet-maintenance', 'Campaign pr_proposed notify failed', { sessionId, err: err.message });
  }

  kickChecks(config, pool, { id: sessionId, branch_name: branch, pr_number: prData.number }, app);

  log.info('fleet-maintenance', 'Campaign PR opened', {
    campaignId: campaign.id, slug: app.slug, prNumber: prData.number, sessionId,
  });
  return { sessionId, prNumber: prData.number, prUrl: prData.html_url };
}

// Fire-and-forget staging build + checks for a freshly opened campaign
// proposal — the kickImportedChecks pattern (routes/votes.js): a
// campaign proposal gets a preview + checks verdict like any native one.
// Never throws into the campaign loop.
function kickChecks(config, pool, session, app) {
  (async () => {
    const visuals = require('./visuals');
    const staging = require('./staging');
    await visuals.setChecksPending(pool, session.id, null, 'building', 'fleet-maintenance')
      .catch((err) => log.warn('fleet-maintenance', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message }));
    visuals.notifyChecksPending(session.id, null, 'building', 'fleet-maintenance');
    let result;
    try {
      result = await staging.buildAndDeployStaging(config, session, app, 'latest');
    } catch (err) {
      const stagingRecovery = require('./staging-recovery');
      await stagingRecovery.recordStagingBootFailure({
        config, pool, session, commitHash: null, err,
      }).catch((e) => log.warn('fleet-maintenance', 'recordStagingBootFailure failed (non-fatal)', { sessionId: session.id, err: e.message }));
      throw err;
    }
    await pool.query(
      `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
      [result.containerId, result.stagingUrl, session.id]
    );
    await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
    visuals.captureForSession(config, session, app, null, result, { trigger: 'fleet-maintenance' })
      .catch((err) => log.warn('fleet-maintenance', 'Campaign visuals capture failed', { sessionId: session.id, err: err.message }));
  })().catch((err) => log.warn('fleet-maintenance', 'Campaign staging build failed', { sessionId: session.id, err: err.message }));
}

// ─── The campaign loop ───────────────────────────────────────────────

async function runCampaign(config, pool, campaignId) {
  if (_running.has(campaignId)) {
    log.info('fleet-maintenance', 'Campaign already running in-process; not re-entering', { campaignId });
    return;
  }
  _running.add(campaignId);
  try {
    const { rows: campRows } = await pool.query(
      'SELECT * FROM maintenance_campaigns WHERE id = $1', [campaignId]
    );
    const campaign = campRows[0];
    if (!campaign || campaign.status !== 'running') return;
    if (!github.isEnabled()) {
      log.warn('fleet-maintenance', 'GitHub disabled — campaign cannot run', { campaignId });
      return;
    }
    if (!llm.isEnabled()) {
      log.warn('fleet-maintenance', 'LLM disabled — campaign cannot run', { campaignId });
      return;
    }
    const platformUserId = await ensurePlatformUser(pool);

    // Seed targets (idempotent — ON CONFLICT keeps prior state on
    // resume). target_filter, when present, is an array of app slugs.
    const filterSlugs = Array.isArray(campaign.target_filter) && campaign.target_filter.length
      ? campaign.target_filter.map(String)
      : null;
    if (filterSlugs) {
      await pool.query(
        `INSERT INTO maintenance_campaign_apps (campaign_id, app_id)
         SELECT $1, a.id FROM apps a
          WHERE a.repo_url IS NOT NULL AND a.self_hosted IS NOT TRUE
            AND a.slug = ANY($2)
         ON CONFLICT (campaign_id, app_id) DO NOTHING`,
        [campaignId, filterSlugs]
      );
    } else {
      await pool.query(
        `INSERT INTO maintenance_campaign_apps (campaign_id, app_id)
         SELECT $1, a.id FROM apps a
          WHERE a.repo_url IS NOT NULL AND a.self_hosted IS NOT TRUE
         ON CONFLICT (campaign_id, app_id) DO NOTHING`,
        [campaignId]
      );
    }

    // Rows stuck 'running' mean the process died mid-app — no PR row
    // was written for them (the PR write and state write are ordered
    // PR-first), so re-running from scratch is safe.
    await pool.query(
      `UPDATE maintenance_campaign_apps
          SET state = 'pending', error = NULL, updated_at = NOW()
        WHERE campaign_id = $1 AND state = 'running'`,
      [campaignId]
    );

    // Few-shot carry-forward: the first successful app's summary keeps
    // later apps consistent. In-process only — after a restart the
    // instructions alone re-seed it from the next success.
    let exemplarSummary = null;

    for (;;) {
      const { rows } = await pool.query(
        `SELECT mca.id AS row_id,
                a.id AS app_id, a.slug, a.name, a.repo_url, a.self_hosted
           FROM maintenance_campaign_apps mca
           JOIN apps a ON a.id = mca.app_id
          WHERE mca.campaign_id = $1 AND mca.state = 'pending'
          ORDER BY mca.id
          LIMIT 1`,
        [campaignId]
      );
      if (!rows.length) break;
      const row = rows[0];
      const app = { id: row.app_id, slug: row.slug, name: row.name, repo_url: row.repo_url };

      await pool.query(
        `UPDATE maintenance_campaign_apps SET state = 'running', updated_at = NOW() WHERE id = $1`,
        [row.row_id]
      );

      try {
        const out = await runAppChange({
          campaign, app, exemplarSummary,
          onUsage: (usage, servedModel) => {
            const cost = llm.estimateCostCents(usage, servedModel);
            // Attributed to the platform user purely as an audit trail
            // of what the campaign spent; non-fatal by construction.
            const limits = require('./limits');
            limits.recordSpend(pool, platformUserId, cost).catch(() => {});
          },
        });

        if (out.skipped) {
          await pool.query(
            `UPDATE maintenance_campaign_apps
                SET state = 'skipped', error = $2, updated_at = NOW()
              WHERE id = $1`,
            [row.row_id, String(out.reason || '').slice(0, 2000)]
          );
          log.info('fleet-maintenance', 'Campaign app skipped', {
            campaignId, slug: app.slug, reason: out.reason,
          });
          continue;
        }

        const opened = await openCampaignProposal({
          config, pool, campaign, app, files: out.files, summary: out.summary, platformUserId,
        });
        if (!exemplarSummary && out.summary) exemplarSummary = out.summary;
        await pool.query(
          `UPDATE maintenance_campaign_apps
              SET state = 'pr_open', session_id = $2, error = NULL, updated_at = NOW()
            WHERE id = $1`,
          [row.row_id, opened.sessionId]
        );
      } catch (err) {
        log.warn('fleet-maintenance', 'Campaign app failed', {
          campaignId, slug: app.slug, err: err.message,
        });
        await pool.query(
          `UPDATE maintenance_campaign_apps
              SET state = 'failed', error = $2, updated_at = NOW()
            WHERE id = $1`,
          [row.row_id, String(err.message || err).slice(0, 2000)]
        ).catch(() => {});
      }
    }

    await pool.query(
      `UPDATE maintenance_campaigns
          SET status = 'done', completed_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [campaignId]
    );

    // Completion note in the platform app's group chat (where the
    // campaign was voted), with the final tallies.
    try {
      const { rows: counts } = await pool.query(
        `SELECT state, COUNT(*)::int AS n
           FROM maintenance_campaign_apps WHERE campaign_id = $1 GROUP BY state`,
        [campaignId]
      );
      const byState = Object.fromEntries(counts.map((r) => [r.state, r.n]));
      const { rows: issueRows } = campaign.issue_id
        ? await pool.query('SELECT app_id FROM issues WHERE id = $1', [campaign.issue_id])
        : { rows: [] };
      if (issueRows.length) {
        const { sendSystemMessage } = require('./ws');
        await sendSystemMessage(pool, issueRows[0].app_id,
          `Maintenance campaign "${campaign.title}" finished fanning out: ` +
          `${byState.pr_open || 0} PRs opened, ${byState.skipped || 0} skipped, ` +
          `${byState.failed || 0} failed. Each PR now runs its own checks and merge vote.`,
          'system');
      }
    } catch (err) {
      log.warn('fleet-maintenance', 'Campaign completion message failed', { campaignId, err: err.message });
    }

    log.info('fleet-maintenance', 'Campaign fan-out complete', { campaignId });
  } finally {
    _running.delete(campaignId);
  }
}

// ─── Merge-all-green ─────────────────────────────────────────────────

/**
 * Sequentially force-merge every campaign proposal whose checks pass
 * (or were skipped). Uses the same exported checkAndMerge the conflict
 * resolver drives, with force so the campaign's platform-level vote —
 * not each app's local tally — is the authority. `forceBy` is the
 * admin who pressed the button, named in the merge audit trail.
 */
async function mergeGreen(config, pool, campaignId, { limit = null, forceBy }) {
  const params = [campaignId];
  let limitSql = '';
  if (Number.isInteger(limit) && limit > 0) {
    params.push(limit);
    limitSql = 'LIMIT $2';
  }
  const { rows } = await pool.query(
    `SELECT mca.id AS row_id, cs.*,
            a.slug AS app_slug, a.repo_url, a.name AS app_name,
            a.self_hosted AS app_self_hosted
       FROM maintenance_campaign_apps mca
       JOIN chat_sessions cs ON cs.id = mca.session_id
       JOIN apps a ON a.id = mca.app_id
      WHERE mca.campaign_id = $1
        AND cs.status = 'promoted'
        AND cs.check_state IN ('passing', 'skipped')
      ORDER BY mca.id
      ${limitSql}`,
    params
  );

  const results = [];
  for (const session of rows) {
    try {
      // Lazy require: votes.js requires services that require this file's
      // siblings; same pattern conflict-resolver uses.
      const { checkAndMerge } = require('../routes/votes');
      const r = await checkAndMerge(config, pool, session, { force: true, forceBy });
      if (r && r.merged) {
        await pool.query(
          `UPDATE maintenance_campaign_apps SET state = 'merged', updated_at = NOW() WHERE id = $1`,
          [session.row_id]
        ).catch(() => {});
        results.push({ slug: session.app_slug, prNumber: session.pr_number, merged: true });
      } else {
        results.push({
          slug: session.app_slug, prNumber: session.pr_number, merged: false,
          reason: (r && r.reason) || 'not merged',
        });
      }
    } catch (err) {
      results.push({
        slug: session.app_slug, prNumber: session.pr_number, merged: false, error: err.message,
      });
    }
    await new Promise((r) => setTimeout(r, MERGE_GREEN_DELAY_MS));
  }
  return results;
}

// ─── Status + retry (dashboard backing) ──────────────────────────────

async function campaignStatus(pool, campaignId) {
  const { rows: campRows } = await pool.query(
    'SELECT * FROM maintenance_campaigns WHERE id = $1', [campaignId]
  );
  if (!campRows.length) return null;
  const campaign = campRows[0];
  // Live merge state comes from the joined session — a proposal the
  // community voted through shows 'merged' here without the engine
  // ever touching the row.
  const { rows: apps } = await pool.query(
    `SELECT mca.app_id, mca.state, mca.error, mca.updated_at, mca.session_id,
            a.slug, a.name,
            cs.pr_number, cs.pr_url, cs.pr_title, cs.check_state, cs.staging_url,
            cs.status AS session_status
       FROM maintenance_campaign_apps mca
       JOIN apps a ON a.id = mca.app_id
       LEFT JOIN chat_sessions cs ON cs.id = mca.session_id
      WHERE mca.campaign_id = $1
      ORDER BY mca.id`,
    [campaignId]
  );
  const rows = apps.map((r) => ({
    appId: r.app_id,
    slug: r.slug,
    name: r.name,
    state: r.session_status === 'merged' ? 'merged' : r.state,
    error: r.error,
    sessionId: r.session_id,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    checkState: r.check_state,
    stagingUrl: r.staging_url,
    updatedAt: r.updated_at,
  }));
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  return {
    id: campaign.id,
    issueId: campaign.issue_id,
    title: campaign.title,
    instructions: campaign.instructions,
    status: campaign.status,
    createdAt: campaign.created_at,
    completedAt: campaign.completed_at,
    counts,
    apps: rows,
  };
}

/**
 * Reset one failed/skipped app to pending and re-enter the campaign
 * loop. Flips a 'done' campaign back to 'running' so the loop picks
 * the row up; a campaign already looping in-process just continues.
 */
async function retryCampaignApp(config, pool, campaignId, appId) {
  const { rowCount } = await pool.query(
    `UPDATE maintenance_campaign_apps
        SET state = 'pending', error = NULL, updated_at = NOW()
      WHERE campaign_id = $1 AND app_id = $2 AND state IN ('failed', 'skipped')`,
    [campaignId, appId]
  );
  if (!rowCount) return false;
  await pool.query(
    `UPDATE maintenance_campaigns SET status = 'running', completed_at = NULL
      WHERE id = $1 AND status = 'done'`,
    [campaignId]
  );
  runCampaign(config, pool, campaignId).catch((err) =>
    log.error('fleet-maintenance', 'Campaign retry run failed', { campaignId, err: err.message }));
  return true;
}

// Boot resume: campaigns are DB-state machines, so a restart mid-fan-out
// just re-enters the loop. Called from server.js after boot.
async function resumeRunningCampaigns(config, pool) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id FROM maintenance_campaigns WHERE status = 'running'`
    ));
  } catch (err) {
    // Fresh DB mid-migration — nothing to resume.
    log.warn('fleet-maintenance', 'Could not query running campaigns (skipping resume)', { err: err.message });
    return;
  }
  for (const row of rows) {
    log.info('fleet-maintenance', 'Resuming maintenance campaign after restart', { campaignId: row.id });
    runCampaign(config, pool, row.id).catch((err) =>
      log.error('fleet-maintenance', 'Campaign resume failed', { campaignId: row.id, err: err.message }));
  }
}

module.exports = {
  PLATFORM_USERNAME,
  MAX_TOOL_ITERATIONS,
  ensurePlatformUser,
  runCampaign,
  mergeGreen,
  campaignStatus,
  retryCampaignApp,
  resumeRunningCampaigns,
  // Exported for unit tests.
  runAppChange,
  openCampaignProposal,
  campaignSystemPrompt,
  CAMPAIGN_TOOLS,
  parseRepo,
};
