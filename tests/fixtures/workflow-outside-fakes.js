'use strict';

// The outside services, faked for the workflow side of a two-process test
// (tests/lib/workflow-child.js): GitHub's API, the container runtime (Docker,
// Kubernetes), the model, and the phone push provider (Firebase). Each
// module keeps its pure helpers, its own in-process caches and its `init`
// real (the child boots through src/workflow/setup.ts as server.js does);
// what would reach the outside is replaced. The push provider is faked at
// its library, so the platform's own push code runs. A call a test did not
// expect fails like an unreachable service, and is recorded as
// `fake.unexpected` so the test can see what its flow touched.
//
// What GitHub would remember (an issue closed, a comment created) is kept in
// wf_test_effects, so a process started after a crash reads it back as it
// would from GitHub.

const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const isClass = (fn) => /^class\b/.test(Function.prototype.toString.call(fn));

// The module with every function replaced by one that fails, except the
// ones kept real and the overrides.
function outside(fakes, rel, { keep = [], overrides = {} }) {
  const real = require(path.join(SRC, rel));
  const kept = new Set(keep);
  const out = {};
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function' || isClass(value) || kept.has(name)) { out[name] = value; continue; }
    out[name] = () => {
      fakes.record('fake.unexpected', { module: rel, fn: name }).catch(() => {});
      throw Object.assign(new Error(`${rel}.${name} reaches an outside service this test does not fake`), { code: 'ECONNREFUSED' });
    };
  }
  fakes.stub(path.join(SRC, rel), { ...out, ...overrides });
}

module.exports = function install(fakes) {
  const comments = async (number) => (await fakes.read('github.comment')).filter((c) => c.number === number);
  outside(fakes, 'services/github', {
    keep: ['init', 'parseGithubUrl', 'safeMention', 'describeGithubError', 'credentialClass', 'clipIssueComments'],
    overrides: {
      isEnabled: () => true,
      // Homeroom can act on the fake repositories' owner through the App.
      canActOn: () => true,
      async getIssue(owner, repo, number) {
        const closed = (await fakes.read('github.close')).some((c) => c.number === number);
        return { number, state: closed ? 'closed' : 'open' };
      },
      async closeIssue(owner, repo, number) { await fakes.record('github.close', { repo: `${owner}/${repo}`, number }); },
      // GitHub creates the comment, then its answer may never arrive: the
      // `github.comment.created` point is between the two.
      async createIssueComment(owner, repo, number, body) {
        await fakes.record('github.comment', { repo: `${owner}/${repo}`, number, body });
        await fakes.pause('github.comment.created');
        return { id: Date.now() };
      },
      async fetchIssueComments(owner, repo, number) {
        return { comments: (await comments(number)).map((c) => ({ body: c.body })), truncated: false };
      },
      // `github.closePR` stops before GitHub closes it.
      async closePR(owner, repo, number) {
        await fakes.pause('github.closePR');
        await fakes.record('github.closePR', { repo: `${owner}/${repo}`, number });
      },
      // A proposal's pull request: a draft until it is marked ready (what
      // GitHub remembers is in wf_test_effects); its head, as the test set
      // it (`github.prHead`), else a fixed one.
      async getPR(owner, repo, number) {
        const ready = (await fakes.read('github.ready')).some((r) => r.number === number);
        const closed = (await fakes.read('github.closePR')).filter((r) => r.number === number).length
          > (await fakes.read('github.reopenPR')).filter((r) => r.number === number).length;
        const head = (await fakes.read('github.prHead')).filter((h) => h.number === number).pop()?.sha || 'c'.repeat(40);
        const merge = (await fakes.read('github.merge')).find((m) => m.number === number);
        if (merge) return { number, state: 'closed', merged: true, merge_commit_sha: merge.sha, merged_at: merge.at, draft: false, head: { sha: head } };
        return { number, state: closed ? 'closed' : 'open', merged: false, draft: !ready, node_id: `PR_${number}`, head: { sha: head } };
      },
      // GitHub merges the pull request at the pinned head, then its answer
      // may never arrive: the `github.merge.done` point is between the two.
      async mergePR(owner, repo, number, sha) {
        if ((await fakes.read('github.merge')).some((m) => m.number === number)) {
          throw Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
        }
        await fakes.record('github.merge', { repo: `${owner}/${repo}`, number, head: sha, sha: '9'.repeat(40), at: new Date().toISOString() });
        await fakes.pause('github.merge.done');
        return { sha: '9'.repeat(40), merged: true };
      },
      async reopenPR(owner, repo, number) { await fakes.record('github.reopenPR', { repo: `${owner}/${repo}`, number }); },
      // The draft marked ready; `github.ready.done` is after GitHub did it,
      // before its answer.
      async markPrReadyForReview(owner, repo, number, pr) {
        if (pr && pr.draft === false) return pr;
        await fakes.record('github.ready', { repo: `${owner}/${repo}`, number });
        await fakes.pause('github.ready.done');
        return { ...pr, draft: false };
      },
      // A pull request's commits, as the test recorded them (`github.prCommits`);
      // the `github.prCommits` point is after GitHub listed them.
      async listPullRequestCommitShas(owner, repo, number) {
        const shas = (await fakes.read('github.prCommits')).filter((c) => c.number === number).flatMap((c) => c.shas);
        await fakes.pause('github.prCommits');
        return { shas, complete: true };
      },
      async getCommitTree() { return null; },
      // Whether a build contains a merge: `github.compare` stops before it answers.
      async compareCommitAncestry(owner, repo, base, head) {
        await fakes.record('github.compare', { base, head });
        await fakes.pause('github.compare');
        return { status: base === head ? 'identical' : 'ahead' };
      },
      // A maintenance campaign's change (src/workflow/campaign/): main's
      // head, its branch, one commit pushed to it (`github.push`), and its
      // pull request (`github.createPR`; the `github.createPR.done` point is
      // after GitHub opened it, before its answer). The pull request's head
      // is the branch's last push.
      async getFileContent() { return 'const secret = process.env.JWT_SECRET;\n'; },
      async getBranchSha() { return 'a'.repeat(40); },
      async createBranch(owner, repo, branch) {
        if ((await fakes.read('github.branch')).some((b) => b.repo === `${owner}/${repo}` && b.branch === branch)) {
          throw Object.assign(new Error('Reference already exists'), { status: 422 });
        }
        await fakes.record('github.branch', { repo: `${owner}/${repo}`, branch });
      },
      async forceBranchToSha(owner, repo, branch, sha) { await fakes.record('github.forceBranch', { repo: `${owner}/${repo}`, branch, sha }); },
      async pushFiles(owner, repo, files, { branch }) {
        const n = (await fakes.read('github.push')).length + 1;
        const sha = String(n % 10).repeat(40).replace(/^./, 'e');
        await fakes.record('github.push', { repo: `${owner}/${repo}`, branch, sha, paths: files.map((f) => f.path) });
        return { sha };
      },
      // `github.findPR` stops before GitHub answers (after the change's push
      // was checkpointed).
      async findOpenPrByBranch(owner, repo, branch) {
        await fakes.pause('github.findPR');
        const pr = (await fakes.read('github.createPR')).find((p) => p.repo === `${owner}/${repo}` && p.branch === branch);
        return pr ? { number: pr.number, html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`, title: pr.title } : null;
      },
      async createPR(owner, repo, { branch, title }) {
        const number = 500 + (await fakes.read('github.createPR')).length;
        const head = (await fakes.read('github.push')).filter((p) => p.repo === `${owner}/${repo}` && p.branch === branch).pop()?.sha;
        await fakes.record('github.createPR', { repo: `${owner}/${repo}`, branch, title, number });
        await fakes.record('github.prHead', { number, sha: head });
        await fakes.record('github.ready', { repo: `${owner}/${repo}`, number });
        await fakes.pause('github.createPR.done');
        return { number, html_url: `https://github.com/${owner}/${repo}/pull/${number}`, title };
      },
      // A production deploy starts by cloning; `github.clone` stops there,
      // and `github.clone:<owner>/<repo>` only that repository's. Every
      // deploy and build that failed here earlier retries through this
      // point, so a test that waits on one app's arms its own.
      async getCloneUrl(owner, repo) {
        await fakes.pause(`github.clone:${owner}/${repo}`);
        await fakes.pause('github.clone');
        throw Object.assign(new Error(`clone of ${owner}/${repo} is not faked`), { code: 'ECONNREFUSED' });
      },
    },
  });
  outside(fakes, 'services/docker', {
    keep: ['containerHostname', 'parseDockerBuildLine', 'STOP_GRACE_SEC', 'STAGING_STOP_GRACE_SEC'],
    overrides: {
      async removeVolume(name) { await fakes.record('docker.removeVolume', { name }); },
      // A merge's worker goes through worker.removeCcVolume, which reads the
      // container by identity and removes the volume with the docker CLI:
      // no container of that name, and the volume's removal recorded as
      // removeVolume's is.
      async execFileAsync(cmd, args) {
        // The real startup retirement inventories outside runtimes. This
        // fixture has none; keep the policy and its database lookup real.
        if (cmd === 'docker' && args[0] === 'ps' && args[1] === '-a') {
          await fakes.record('docker.ps');
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'docker' && args[0] === 'inspect') {
          throw Object.assign(new Error('No such object'), { stderr: `Error: No such object: ${args.at(-1)}` });
        }
        if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'rm') {
          await fakes.record('docker.removeVolume', { name: args.at(-1) });
          return { stdout: '', stderr: '' };
        }
        await fakes.record('fake.unexpected', { module: 'services/docker', fn: `execFileAsync ${cmd} ${args[0]}` });
        throw Object.assign(new Error(`docker ${args[0]} reaches an outside service this test does not fake`), { code: 'ECONNREFUSED' });
      },
    },
  });
  outside(fakes, 'services/kubernetes', { keep: [] });
  // The model is off, unless the test process starts the workflow process
  // with WF_FAKE_MODEL=1: then a campaign's change is one scripted turn
  // (`llm.call`; the `llm.call` point is inside it), staging an edit and
  // finishing, or skipping an app whose slug says so.
  outside(fakes, 'services/llm', { keep: ['init'], overrides: {
    isEnabled: () => process.env.WF_FAKE_MODEL === '1',
    estimateCostCents: () => 0,
    async streamChat({ messages }) {
      await fakes.record('llm.call', {});
      await fakes.pause('llm.call');
      if (/slug skip-/.test(String(messages?.[0]?.content || ''))) {
        return { toolUses: [{ id: 't1', name: 'skip_app', input: { reason: 'Nothing to change here.' } }],
          rawContent: [], stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, servedModel: 'fake' };
      }
      return {
        toolUses: [
          { id: 't1', name: 'write_file', input: { path: 'server.js', content: 'const key = process.env.USERNODE_JWT_PUBLIC_KEY;\n' } },
          { id: 't2', name: 'finish', input: { summary: 'Switched server.js to the public key.' } },
        ],
        rawContent: [], stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, servedModel: 'fake',
      };
    },
  } });
  // Firebase: what a push to a phone carries, recorded (`push.send`).
  const firebase = (name, exports) => fakes.stub(require.resolve(name, { paths: [SRC] }), exports);
  firebase('firebase-admin/app', { initializeApp: (o, name) => ({ name }), cert: (account) => account, deleteApp: async () => {} });
  firebase('firebase-admin/messaging', { getMessaging: () => ({
    async send(message) {
      await fakes.record('push.send', { token: message.token, badge: message.apns?.payload?.aps?.badge ?? null });
      return 'projects/test/messages/1';
    },
  }) });
  // A before & after shots run's steps (services/shots-orchestrator.js): its
  // copies are builds and runtimes, its agent a turn in a worker. Each is
  // recorded; the copies stop at `shots.copies.built`, after their images
  // are built (handed over for the step's checkpoint) and before anything
  // else, and they write the agent's workspace as the real step does; the
  // agent saves a before and an after into it.
  const shotsFile = (runId, side) => pool().query(
    `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type, data, bytes, sha256)
     VALUES ($1, $2, 'c1', 'desktop', $3, 'context', 'png', 'image/png', $4, 3, $5) ON CONFLICT DO NOTHING`,
    [runId, `c1/desktop/${side}/context`, side, Buffer.from(side), side === 'base' ? 'b'.repeat(64) : 'd'.repeat(64)]);
  const pool = () => require(path.join(SRC, 'db/pool')).getPool();
  outside(fakes, 'services/shots-orchestrator', {
    keep: ['platformFault', 'visibleError', 'exactSha', 'headForSession', 'loadSession', 'publicSessionAndApp'],
    overrides: {
      async resolveRevision(_pool, { sessionId, headSha }) {
        await fakes.record('shots.revision', { sessionId, headSha });
        return { baseSha: '0'.repeat(40), headSha };
      },
      async buildCopies(_config, db, o) {
        await fakes.record('shots.copies', { runId: o.runId, reused: !!o.images, fresh: !!o.fresh });
        if (!o.images && o.onImages) await o.onImages({ base: { imageRef: 'img:b', imageDigest: 'sha256:b' }, head: { imageRef: 'img:h', imageDigest: 'sha256:h' } });
        await fakes.pause('shots.copies.built');
        await db.query(
          `INSERT INTO shot_run_control (run_id, session_id, intent, context, expires_at)
           VALUES ($1, $2, $3::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 hour') ON CONFLICT DO NOTHING`,
          [o.runId, o.sessionId, JSON.stringify(o.intent)]);
        return { fixtureFingerprint: 'fp', baseImageDigest: 'sha256:b', headImageDigest: 'sha256:h', afterOnly: false };
      },
      async dispatchAgent(_config, _db, o) {
        await fakes.record('shots.agent', { runId: o.runId });
        await shotsFile(o.runId, 'base');
        await shotsFile(o.runId, 'head');
        return { agent: { outcome: 'completed' }, passed: true, readyCount: 1, failedCount: 0, skippedAny: false,
          verdict: { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'c1', status: 'ready', files: 2 }] },
          manifestHash: 'e'.repeat(64), slots: ['c1/desktop/base/context', 'c1/desktop/head/context'], trace: {} };
      },
      async compareScreens(_db, { verdict }) { return verdict; },
      async cleanupRun(_config, db, o) {
        await fakes.record('shots.cleanup', { runId: o.runId });
        await db.query('DELETE FROM shot_run_control WHERE run_id = $1', [o.runId]);
        return { cleaned: true, version: 2 };
      },
    },
  });
  // A session's worker container: destroying it is recorded (the container
  // runtime is outside); everything else in the module is real.
  const worker = require(path.join(SRC, 'services/worker'));
  fakes.stub(path.join(SRC, 'services/worker'), {
    ...worker,
    async destroyWorker(name) { await fakes.record('worker.destroy', { name }); },
    // The proposal machine's fenced removal: asks to proceed, then removes.
    async removeWorker(sessionId, { proceed = async () => true } = {}) {
      if (!(await proceed())) return { skipped: true };
      await fakes.record('worker.destroy', { name: worker.workerContainerName(sessionId) });
      return { removed: true };
    },
  });
  // The merge gate (routes/votes.js evaluateMergeGate) reads the mirror, the
  // live revision and the protected-settings check from GitHub: its I/O is
  // faked to "ready at the row's head" (the claim still reads every deciding
  // input under the lock, for real). GitHub's merge (attemptMerge) is real.
  const votes = require(path.join(SRC, 'routes/votes'));
  fakes.stub(path.join(SRC, 'routes/votes'), {
    ...votes,
    async evaluateMergeGate(_config, _pool, session) {
      await fakes.record('merge.gate', { sessionId: session.id });
      return { ready: true, head: session.reviewed_head_sha, epoch: Number(session.approval_epoch) || 0,
        explicitApproval: false, explicitReason: null, mainPassThrough: false, tally: { yes: 1, required: 1, active: 1 } };
    },
  });
  // A sync with main is a worker turn: faked at its core (services/sync-main.js
  // runSyncWork), which stops at `sync.turn` while it runs.
  const syncMain = require(path.join(SRC, 'services/sync-main'));
  fakes.stub(path.join(SRC, 'services/sync-main'), {
    ...syncMain,
    async runSyncWork(_config, _db, o) {
      await fakes.record('sync.run', { sessionId: o.sessionId, reason: o.reason });
      await fakes.pause('sync.turn');
      return { outcome: 'clean', sha: 'd'.repeat(40), message: 'Merged main cleanly.' };
    },
  });
  // The Homeroom bot's look at a request (bot-request's bot.look, services/
  // homeroom-bot.js lookAt) is a worker turn: faked at its core, stopping at
  // `bot.look` while it runs; and its lane's refresh and sweeps, which read
  // GitHub and the fleet, record only.
  const homeroomBot = require(path.join(SRC, 'services/homeroom-bot'));
  fakes.stub(path.join(SRC, 'services/homeroom-bot'), {
    ...homeroomBot,
    async lookAt(_config, _db, o) {
      await fakes.record('bot.look', { appId: o.input.appId, issueNumber: o.input.issueNumber, n: o.input.n, pid: process.pid });
      await fakes.pause('bot.look');
      return { outcome: 'done' };
    },
    async refresh() { await fakes.record('bot.refresh', {}); return {}; },
    async sweep() { await fakes.record('bot.sweep', {}); return {}; },
  });
  // The Homeroom bot's chat model (its voice in projects, its DM): one
  // scripted answer, a reply that names the message it answers, stopping at
  // `bot.model` while it is asked. Its key is the bot's own, read from the
  // credential store, which answers here that it has one.
  const openrouter = require(path.join(SRC, 'services/openrouter'));
  fakes.stub(path.join(SRC, 'services/openrouter'), {
    ...openrouter,
    async streamChat(req) {
      const last = [...(req.messages || [])].reverse().find((m) => m.role === 'user');
      await fakes.record('bot.model', { pid: process.pid });
      await fakes.pause('bot.model');
      const words = String(last?.content || '');
      const asked = /#(\d+)/.exec(words.slice(words.lastIndexOf('Answer what was said to you'))) ? 'the place' : 'the DM';
      const calls = [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: `Here is my answer in ${asked}.` }) } }];
      return { content: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  });
  const store = require(path.join(SRC, 'services/credential-store'));
  fakes.stub(path.join(SRC, 'services/credential-store'), {
    ...store,
    async readMetadata() { return { status: 'valid' }; },
    async readSecret() { return 'sk-fake-bot-key'; },
  });
  // main's unit suite on a commit (the main-check machine's main.suite work,
  // services/main-watch.js runMainSuite): the run's queue id kept first, as
  // the real run does before its Jobs exist, then the `main.suite` point,
  // then green. What each attempt was handed is recorded (`main.suite`).
  const mainWatch = require(path.join(SRC, 'services/main-watch'));
  fakes.stub(path.join(SRC, 'services/main-watch'), {
    ...mainWatch,
    async runMainSuite(_config, _db, { app, sha, resumeRunId = null, onRunId = null }) {
      await fakes.record('main.suite', { appId: app.id, sha, resumeRunId });
      if (!resumeRunId && onRunId) await onRunId(`run-${app.id}-${sha.slice(0, 8)}`);
      await fakes.pause('main.suite');
      return { state: 'passing', detail: { summary: { tests: 1, pass: 1, fail: 0 } } };
    },
  });
  // Not an outside service, a probe: whether the Workshop hears a board
  // change in this process (its listener is registered by server.js, and
  // fired by the bus's relay of the machine's push).
  const themes = require(path.join(SRC, 'services/workshop-themes'));
  fakes.stub(path.join(SRC, 'services/workshop-themes'), {
    ...themes, noteBoardChange: (pool, info) => { fakes.record('workshop.boardChange', info).catch(() => {}); return true; },
  });
};
