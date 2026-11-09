// Whether one of the Homeroom bot's changes up for a vote is ready to try,
// still waits on its before & after shots, or is due a fix round first: the
// bot-change machine decides from these (src/workflow/bot-change/), and the
// code not migrated yet imports them back (services/shots-state.js,
// services/homeroom-bot-followup.js, services/pr-vote-revision.js), so there
// is one copy. Pure: every input is the session row as chat_sessions stores
// it, and the time is the caller's (a transition's ctx.now).

type Row = Record<string, any>;

// ── Heads ───────────────────────────────────────────────────────────────

// The revision up for a vote: an imported pull request's GitHub head, else
// the reviewed head the promote recorded.
export function reviewedHeadForSession(session: Row | null | undefined): string | null {
  return session?.source === 'imported'
    ? (session.imported_pr_head_sha || null)
    : (session?.reviewed_head_sha || null);
}

// The commit a stored preview artifact must describe before it may be shown:
// the reviewed head, else the checks' or the hand-off's pin.
export function visualHeadForSession(session: Row | null | undefined): string | null {
  return reviewedHeadForSession(session)
    || session?.checks_commit_sha
    || session?.handoff_head_sha
    || null;
}

// Case-insensitive: every writer lands a lower-case sha, but one upper-case
// character must not make an identical commit read as another (#955).
export function sameSha(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

const lowerSha = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const timeOf = (v: unknown): number => {
  if (v == null) return NaN;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : NaN;
};
const clip = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};

// ── The shots on a head ─────────────────────────────────────────────────

const IN_FLIGHT_STATES: ReadonlySet<string> = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const TERMINAL_STATES: ReadonlySet<string> = new Set(['verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden']);
// services/visible-changes.js MAX_STORIES: at most this many declared changes.
const MAX_STORIES = 3;
// How long a ready-to-try message waits on shots that have not settled,
// from the later of the checks verdict on the head and the slot's last move.
// The shots machine settles every run it starts (bounded by its own
// deadlines) and tells the bot, so this matters only when no settle comes.
export const READY_HOLD_MS = 45 * 60_000;

export interface Claim { id: string; claim: string; steps: string[]; reason: string | null }

// The declared changes whose result in the settled shots on `headSha`
// passes `keep`. Empty for shots on another head and unsettled shots.
function resultsOnHead(row: Row | null | undefined, headSha: unknown, keep: (result: Row, declared: Row) => boolean): Claim[] {
  const detail = row?.shots_detail;
  const head = lowerSha(headSha);
  if (!detail || typeof detail !== 'object' || !head) return [];
  if (!['verified', 'failed'].includes(row!.shots_state)) return [];
  if (lowerSha(detail.headSha) !== head) return [];
  const claims: Row[] = Array.isArray(detail.claims) ? detail.claims : [];
  const results: Row[] = Array.isArray(detail.shotResults) ? detail.shotResults : [];
  return results.filter((result) => result && typeof result.id === 'string')
    .map((result) => ({ result, declared: claims.find((c) => c && c.id === result.id) || {} }))
    .filter(({ result, declared }) => keep(result, declared))
    .slice(0, MAX_STORIES)
    .map(({ result, declared }) => ({
      id: result.id,
      claim: clip(declared.claim, 300) || result.id,
      steps: Array.isArray(declared.steps) ? declared.steps.slice(0, 12).map((s: unknown) => String(s).slice(0, 200)) : [],
      reason: clip(result.reason, 1000),
    }));
}

// The declared changes the shots on `headSha` show failing (the agent did
// the steps and the after build broke).
export function brokenOnHead(row: Row | null | undefined, headSha: unknown): Claim[] {
  return resultsOnHead(row, headSha, (result) => result.status === 'failed');
}

// A skip its author can fix: the reason names data the copies lack and no
// cause a seed cannot supply (services/shots-state.js tells the history).
const MISSING_DATA_RE = /\bfixtures?\b|\bno\b[^.;:]{0,60}?\b(?:rows?|records?|data|changes?|projects?|apps?|members?|accounts?|items?|entries|messages?|cards?|runs?|requests?|states?|seeds?)\b|\bdoes(?: not|n't) exist\b|\b(?:is|are)(?: not|n't) (?:on|in) (?:these|this|the|either) (?:copies|copy|after copy)\b/i;
const NOT_SEEDABLE_RE = /\bmodel\b|\bwallets?\b|\bupload|file chooser|e-?mail|mailbox|\boffline\b|connection drop|network (?:request|connection)|stub fetch|geolocation|location permission|camera|microphone|clipboard|\bnot signed in\b|sign(?:ing|-| )in (?:is|isn't|is not)|browser(?:-| )tab|favicon|too fast|in flight|(?:hold|delay)(?: or (?:hold|delay))? (?:the )?(?:api )?requests?|\b(?:401|403|5\d\d)\b|unauthori[sz]ed|server error|did not save/i;

export function seedableSkip(reason: unknown): boolean {
  const text = typeof reason === 'string' ? reason : '';
  return MISSING_DATA_RE.test(text) && !NOT_SEEDABLE_RE.test(text);
}

// The declared changes the shots on `headSha` skipped for want of data the
// proposal itself could seed, on a change declared new on the after side.
export function skippedOnHead(row: Row | null | undefined, headSha: unknown): Claim[] {
  return resultsOnHead(row, headSha, (result, declared) => result.status === 'skipped'
    && declared.baseState === 'not_present' && seedableSkip(result.reason));
}

// Until when shots of `headSha` are still to come, so the change is not yet
// ready to try (ms since the epoch), or null when they hold nothing: nothing
// visible declared, the shots on this head settled, a run that will not
// start, or READY_HOLD_MS gone since the later of the checks verdict and the
// slot's last move.
export function heldUntil(row: Row | null | undefined, headSha: unknown, now: number): number | null {
  const detail = row?.shots_detail;
  const head = lowerSha(headSha);
  if (!detail || typeof detail !== 'object' || !head) return null;
  if (detail.required === false || row!.shots_state === 'not_required' || !row!.shots_state) return null;
  const since = Math.max(timeOf(row!.checks_checked_at) || 0, timeOf(row!.shots_updated_at) || 0);
  if (!since || now - since > READY_HOLD_MS) return null;
  const until = since + READY_HOLD_MS;
  const onHead = !detail.headSha || lowerSha(detail.headSha) === head;
  if (onHead && row!.shots_run_id) return IN_FLIGHT_STATES.has(row!.shots_state) ? until : null;
  if (onHead && TERMINAL_STATES.has(row!.shots_state)) return null;
  if (row!.shots_state === 'planned' && typeof detail.notStartedReason === 'string' && detail.notStartedReason.trim()) return null;
  const stories = detail.intent && Array.isArray(detail.intent.stories) ? detail.intent.stories : [];
  return stories.length > 0 ? until : null;
}

export function holdsReady(row: Row | null | undefined, headSha: unknown, now: number): boolean {
  return heldUntil(row, headSha, now) != null;
}

// ── Checks the bot fixes ────────────────────────────────────────────────

const READY_CHECKS: ReadonlySet<string> = new Set(['passing', 'skipped']);
// The verdicts a change's failed shots are acted on beside: once the checks
// on its head settled, so one round sees everything that failed.
const SETTLED_CHECKS: ReadonlySet<string> = new Set(['passing', 'failing', 'skipped']);
export const FAILING_REASON_CHARS = 800;

const clipText = (v: unknown, max: number) => {
  const t = String(v || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// A check row's reason, as the proposal's own checks panel reads it.
export function failureReason(row: Row | null | undefined): string {
  const direct = String(row?.failureReason == null ? '' : row.failureReason).trim();
  if (direct) return direct;
  const errors: Row[] = Array.isArray(row?.consoleErrors) ? row!.consoleErrors : [];
  const first = errors.find((e) => e && e.message);
  return first ? String(first.message) : '';
}

export interface Failing {
  name: string; path: string | null; reason: string;
  // #6536: the failed preview build's own first error, as the check row
  // stored it. Written into the fix turn's prompt; `previewBuild` says the
  // failure is the build, not a check that did not pass.
  previewBuild?: boolean;
  buildExcerpt?: string | null;
}

// How much of a failed build's log the fix turn is shown. The row stores up
// to 40 lines ending at the first error (src/services/deploy-failure.js).
export const BUILD_EXCERPT_CHARS = 4000;

// The checks that block the proposal, from its stored `test_results`: a row
// that did not pass and is not advisory (the merge gate's own rule).
export function failingChecks(testResults: unknown): { failing: Failing[]; total: number } {
  const rows: Row[] = Array.isArray(testResults) ? testResults.filter((r) => r && typeof r === 'object') : [];
  const failing = rows
    .filter((r) => r.status !== 'pass' && !r.advisory)
    .map((r) => ({
      name: clipText(r.name || r.path || 'unnamed check', 200),
      path: r.path ? clipText(r.path, 200) : null,
      reason: clipText(failureReason(r), FAILING_REASON_CHARS),
      ...(r.previewBuild
        ? { previewBuild: true, buildExcerpt: clipText(r.buildExcerpt, BUILD_EXCERPT_CHARS) || null }
        : {}),
    }));
  return { failing, total: rows.length };
}

export interface Due { head: string; failing: Failing[]; total: number; broken?: Claim[]; skipped?: Claim[] }

// The fix a proposal is due, from its row: a failing verdict on its CURRENT
// (reviewed) head, the declared changes its shots on that head show failing,
// and those they skipped for want of data the change can seed, that no fix
// round looked at yet (`looked`: a run of the bot's recorded that head). A
// skip is due only until a fix round revised the proposal (`fix_revised`):
// one round per commit, never a loop.
export function checksDue(row: Row | null | undefined): Due | null {
  if (!row) return null;
  const head = String(row.reviewed_head_sha || '').toLowerCase();
  if (!head || row.looked) return null;
  const onHead = String(row.checks_commit_sha || '').toLowerCase() === head;
  // #6536: a preview build that failed with its own error is a check row on
  // an 'error' verdict (src/workflow/preview/machine.ts), and it is due the
  // same fix a failing check is.
  const buildBroken = Array.isArray(row.test_results) && row.test_results.some((r: Row) => r && r.previewBuild);
  const { failing, total } = onHead && (row.check_state === 'failing' || (row.check_state === 'error' && buildBroken))
    ? failingChecks(row.test_results)
    : { failing: [] as Failing[], total: Array.isArray(row.test_results) ? row.test_results.length : 0 };
  const broken = SETTLED_CHECKS.has(row.check_state) ? brokenOnHead(row, row.reviewed_head_sha) : [];
  const skipped = row.fix_revised || !SETTLED_CHECKS.has(row.check_state) ? [] : skippedOnHead(row, row.reviewed_head_sha);
  if (!failing.length && !broken.length && !skipped.length) return null;
  return { head, failing, total, ...(broken.length ? { broken } : {}), ...(skipped.length ? { skipped } : {}) };
}

// ── Ready to try ────────────────────────────────────────────────────────

export interface Readiness {
  // Up for a vote, its checks passed or skipped on the head up for a vote.
  checked: boolean;
  ready: boolean;
  epoch: number;
  head: string | null;
  // Until when its shots hold it (ms), when they do.
  heldUntil: number | null;
  broken: Claim[];
  skipped: Claim[];
}

// Whether the change is ready to try: up for a vote, its checks passed or
// skipped on the head up for a vote (a verdict about another commit is not
// its own), and its shots on that head settled (or held long enough).
export function readiness(row: Row, now: number): Readiness {
  const head = visualHeadForSession(row);
  const reviewed = reviewedHeadForSession(row);
  const onHead = !reviewed || !row.checks_commit_sha || sameSha(row.checks_commit_sha, reviewed);
  const checked = row.status === 'promoted' && READY_CHECKS.has(row.check_state) && onHead;
  const until = checked ? heldUntil(row, head, now) : null;
  return {
    checked,
    ready: checked && until == null,
    epoch: Number(row.approval_epoch) || 0,
    head: head ? head.toLowerCase() : null,
    heldUntil: until,
    broken: checked ? brokenOnHead(row, head) : [],
    skipped: checked ? skippedOnHead(row, head) : [],
  };
}
