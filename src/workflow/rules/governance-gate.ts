// The merge gate: when a proposal (a pull request or a governance issue)
// has the votes, and the time, to merge or apply. Pure, and the one copy:
// services/active-users.js and services/governance.js re-export it for the
// merge route, the serializers, the sweepers and the client's countdown, and
// the governance workflow machine decides with it inside its transaction.
//
// The knobs are constants. They were read from the environment once per
// process, which let two processes (the old and new Pods of a release) give
// one proposal two verdicts; none was ever set.
//
// A proposal merges through one of two paths (see SPEC: "Visibility window
// + dynamic threshold"):
//
//   A. Threshold path: both gates below hold (eased Yes threshold met AND
//      the minimum visibility window has elapsed).
//   B. Lazy-consensus path: the threshold is NOT met, but the proposal has
//      real unopposed support (>= 1 Yes, Yes strictly leading, not
//      contested) and its lazy merge window has elapsed. Silence is consent:
//      on small apps the threshold (floored at 2) is often unreachable
//      because the other members simply never vote. See lazyWindowMs.
//
// Two independent, pure gates that both must hold for the threshold path:
//
//   1. requiredVotes(active, noCount): the eased Yes-vote threshold. Largest
//      discount when unopposed; rises back toward the simple majority M as No
//      votes arrive; never exceeds M and never drops below an anti-self-merge
//      floor.
//
//   2. mergeWindowMs(active, yesCount, noCount): a minimum *visibility
//      window* measured from when the proposal opened. Shrinks as the Yes
//      fraction climbs (7d at low participation → 3d at 1/3 → 0 at majority,
//      with a front-loaded non-linear drop between 1/3 and 1/2), and is
//      pushed back out toward the 7d max by opposition. A clear majority
//      (yes >= M) or a Contested proposal (No fraction >= 1/3) collapses the
//      window to 0.

import {
  BUILT_IN_GROUPS, PRESET_KEYS, WHO_DECIDES, evaluateRules, groupKey, matchPreset,
} from './governance-rules.ts';
import type { PresetKey, Rule, RulesFacts } from './governance-rules.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Dynamic-threshold knobs: a quarter-of-active discount when unopposed
// (BASE_DISCOUNT_DIVISOR=4), each No worth two votes of that discount
// (DOWN_WEIGHT=2), never below two Yes once an app has >=2 active users
// (FLOOR=2).
const BASE_DISCOUNT_DIVISOR = 4;
const DOWN_WEIGHT = 2;
const FLOOR = 2;

// Visibility-window knobs (windows in ms).
const WINDOW_MAX_MS = 7 * DAY_MS;
const WINDOW_MID_MS = 3 * DAY_MS;
const WINDOW_CURVE_EXP = 3;
// Fraction breakpoints. The mid mark is where the window settles to
// WINDOW_MID_MS; the majority mark is where it collapses to 0; the contested
// mark is the No fraction at which the window stops applying entirely.
const YES_MID_FRAC = 1 / 3;
const YES_MAJORITY_FRAC = 1 / 2;
const CONTESTED_NO_FRAC = 1 / 3;

// Auto-takedown (rejection) knobs, the symmetric mirror of the merge window.
// A proposal that the group is voting down (No > Yes) without ever reaching a
// base of support (Yes fraction < REJECT_KEEPALIVE_YES_FRAC) gets a rejection
// window: ~7d when No only barely leads, shrinking non-linearly toward instant
// as No dominates. REJECT_MIN_NO mirrors the merge FLOOR so a lone No can never
// auto-close. The keep-alive fraction reuses YES_MID_FRAC (1/3).
const REJECT_WINDOW_MAX_MS = 7 * DAY_MS;
const REJECT_CURVE_EXP = 3;
const REJECT_MIN_NO = 2;
const REJECT_KEEPALIVE_YES_FRAC = YES_MID_FRAC;

// An admin's lone No (#5803). One No never arms the opposition curve above,
// because one person's objection should not end a change while the group may
// still vote. When that person is one of the project's admins, the group asked
// for a clock anyway: a week with no Yes from anyone means nobody wants it.
// Same week as the longest rejection window and the quiet rule.
export const ADMIN_NO_WINDOW_MS = 7 * DAY_MS;

// An approver's lone No (#5947). On a project where only its invited
// approvers' votes count, nothing else ever ends a change an approver turned
// down: the at-least-N rule has no clock, and the people whose Yes votes are
// only advisory cannot carry it. So a change with an approver's No and no
// counted Yes is set aside this many days after that No. The one setting:
// every window, line and sentence reads it from here.
export const APPROVER_NO_WINDOW_DAYS: number = 2;
export const APPROVER_NO_WINDOW_MS = APPROVER_NO_WINDOW_DAYS * DAY_MS;
// The window as a sentence says it ("within 2 days").
export const APPROVER_NO_WINDOW_WORDS = APPROVER_NO_WINDOW_DAYS === 1 ? '1 day' : `${APPROVER_NO_WINDOW_DAYS} days`;

// Lazy-consensus knobs: a proposal that has SOME support (Yes strictly
// leading, no contest) but hasn't reached the eased threshold arms a merge
// clock anyway: silence is consent. The clock is count-based (NOT
// fraction-based like mergeWindowMs) because on the platform's typical 2–4
// active-user apps, fractions quantize so coarsely that a single Yes is
// already 25–50% and the fraction curves degenerate (see #310 follow-up:
// timers were unreachable below 5 active users). One missing vote → 3d,
// each additional missing vote → +2d, capped at the 7d max.
const LAZY_WINDOW_BASE_MS = 3 * DAY_MS;
const LAZY_WINDOW_STEP_MS = 2 * DAY_MS;

export const MERGE_GATE_CONSTANTS = Object.freeze({
  BASE_DISCOUNT_DIVISOR,
  DOWN_WEIGHT,
  FLOOR,
  WINDOW_MAX_MS,
  WINDOW_MID_MS,
  WINDOW_CURVE_EXP,
  YES_MID_FRAC,
  YES_MAJORITY_FRAC,
  CONTESTED_NO_FRAC,
  REJECT_WINDOW_MAX_MS,
  REJECT_CURVE_EXP,
  REJECT_MIN_NO,
  REJECT_KEEPALIVE_YES_FRAC,
  LAZY_WINDOW_BASE_MS,
  LAZY_WINDOW_STEP_MS,
});

type Count = number | string | null | undefined;
type Instant = Date | number | string | null | undefined;

const int = (v: Count): number => parseInt(String(v), 10);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// The eased Yes-vote threshold. Pure. M = floor(active/2)+1 is both the
// simple majority and the hard upper cap (opposition can restore the bar but
// never push it above majority: no permanent deadlock).
export function requiredVotes(active: Count, noCount: Count): number {
  const a = Math.max(int(active) || 0, 1);
  const no = Math.max(int(noCount) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  const discount = Math.max(0, Math.floor(a / BASE_DISCOUNT_DIVISOR) - DOWN_WEIGHT * no);
  const floorEff = Math.min(FLOOR, M);
  return clamp(M - discount, floorEff, M);
}

// Whether opposition has crossed the "Contested" line: at/above this the
// window no longer applies and the proposal is a pure simple-majority count
// gate.
export function isContested(active: Count, noCount: Count): boolean {
  const a = Math.max(int(active) || 0, 1);
  const no = Math.max(int(noCount) || 0, 0);
  return no / a >= CONTESTED_NO_FRAC;
}

// The minimum visibility window in ms. Pure. See the block comment above for
// the shape; returns 0 whenever the window doesn't gate (majority reached or
// contested).
export function mergeWindowMs(active: Count, yesCount: Count, noCount: Count): number {
  const a = Math.max(int(active) || 0, 1);
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  // A clear majority satisfies the window instantly ("majority just merges").
  if (yes >= M) return 0;
  const yesFrac = yes / a;
  const noFrac = no / a;
  // Contested: opposition has removed the window entirely.
  if (noFrac >= CONTESTED_NO_FRAC) return 0;

  let yesWindow;
  if (yesFrac >= YES_MAJORITY_FRAC) {
    // >= 1/2 of active said Yes: collapse to instant.
    yesWindow = 0;
  } else if (yesFrac < YES_MID_FRAC) {
    // Low participation: linear ramp 7d (at 0) -> 3d (at 1/3).
    const f = yesFrac / YES_MID_FRAC;
    yesWindow = WINDOW_MAX_MS + f * (WINDOW_MID_MS - WINDOW_MAX_MS);
  } else {
    // Between 1/3 and 1/2: non-linear, front-loaded 3d -> 0. Stays near 3d
    // for most of the range, then drops sharply as Yes nears a majority.
    const t = (yesFrac - YES_MID_FRAC) / (YES_MAJORITY_FRAC - YES_MID_FRAC);
    yesWindow = WINDOW_MID_MS * (1 - Math.pow(t, WINDOW_CURVE_EXP));
  }

  // No-vote pushback: blend the Yes-driven window back toward the max on a
  // gradient as the No fraction rises from 0 toward the contested cut-off.
  const p = clamp(noFrac / CONTESTED_NO_FRAC, 0, 1);
  const windowMs = yesWindow + p * (WINDOW_MAX_MS - yesWindow);
  return Math.round(clamp(windowMs, 0, WINDOW_MAX_MS));
}

// The auto-takedown (rejection) window in ms, or `null` when no rejection
// clock applies. Pure, and the symmetric mirror of mergeWindowMs. The `null`
// sentinel distinguishes "not armed / kept alive" from "armed, reject
// instantly" (0). Returns:
//   - null  if Yes fraction >= keep-alive (a base of support protects it),
//   - null  if No does not strictly outnumber Yes, or No < REJECT_MIN_NO
//           (a lone No can never auto-close: mirrors the merge FLOOR),
//   - else  REJECT_WINDOW_MAX_MS * (1 - t**REJECT_CURVE_EXP), where the
//           dominance margin t = (no - yes) / (no + yes): ~max when No barely
//           leads, front-loaded down toward 0 as No dominates Yes.
export function rejectionWindowMs(active: Count, yesCount: Count, noCount: Count): number | null {
  const a = Math.max(int(active) || 0, 1);
  const yes = Math.max(int(yesCount) || 0, 0);
  // Keep-alive: any real base of Yes support cancels the rejection clock.
  if (yes / a >= REJECT_KEEPALIVE_YES_FRAC) return null;
  return oppositionWindowMs(yesCount, noCount);
}

// The arming guard and the curve, WITHOUT a keep-alive rule (#2494).
//
// Split out because the two governance modes agree on when opposition should
// start a clock and how fast it should run, and disagree only on what
// protects a proposal from it. The default mode's keep-alive is a fraction of
// the ACTIVE user count (above); at-least-N has no meaningful active
// denominator, and its own protection is simply having reached the approval
// threshold (atLeastGate).
//
// One copy of the curve on purpose: two copies of a governance rule is how
// one of them gets tuned and the other quietly does not.
export function oppositionWindowMs(yesCount: Count, noCount: Count): number | null {
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  // Arming guard: only once No strictly leads Yes AND clears the min-No
  // floor. A tie is a stalemate, not a rejection, and a lone No can never
  // auto-close anything.
  if (no <= yes || no < REJECT_MIN_NO) return null;
  const t = (no - yes) / (no + yes); // dominance margin in (0, 1]
  const windowMs = REJECT_WINDOW_MAX_MS * (1 - Math.pow(t, REJECT_CURVE_EXP));
  return Math.round(clamp(windowMs, 0, REJECT_WINDOW_MAX_MS));
}

// The lazy-consensus merge window in ms, or `null` when it doesn't apply.
// Pure. Arms when a proposal has real support but hasn't reached the eased
// threshold: at least 1 Yes, Yes strictly leading No, and not contested.
// While armed, the proposal auto-merges once the window elapses: silence is
// consent; the visibility window IS the objection period. Returns:
//   - null  if yes >= requiredVotes (the threshold path owns the clock),
//   - null  if yes < 1, or No ties/leads Yes (a tie is a stalemate, and a
//           No lead belongs to the rejection clock: mutual exclusivity),
//   - null  if contested (No >= 1/3 of active: all clocks off, pure
//           majority race),
//   - else  LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS where
//           missing = required - yes, capped at WINDOW_MAX_MS. Count-based
//           on purpose: see the knobs comment above.
export function lazyWindowMs(active: Count, yesCount: Count, noCount: Count): number | null {
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  const required = requiredVotes(active, noCount);
  if (yes >= required) return null;
  if (yes < 1 || yes <= no) return null;
  if (isContested(active, noCount)) return null;
  const missing = required - yes;
  return Math.round(clamp(
    LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS,
    0, WINDOW_MAX_MS,
  ));
}

export interface Gate {
  required: number;
  windowMs: number;
  windowEndsAt: string | null;
  contested: boolean;
  thresholdMet: boolean;
  windowElapsed: boolean;
  lazyArmed: boolean;
  lazyWindowMs: number | null;
  mergeable: boolean;
  rejectionWindowMs: number | null;
  rejectionArmed: boolean;
  rejectionEndsAt: string | null;
  rejectable: boolean;
}

// One-call convenience that derives every field the merge route, sweeper,
// and client need from a single (active, yes, no, openedAt) snapshot. `now`
// and `openedAt` accept a Date, ms number, or ISO string; `openedAt` falls
// back to `now` when missing (so a proposal with no anchor is treated as
// just-opened).
export function mergeGate(active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant): Gate {
  const toMs = (v: Instant, fallback: number): number => {
    if (v == null) return fallback;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : fallback;
  };
  const nowMs = toMs(now, Date.now());
  const openedMs = toMs(openedAt, nowMs);
  const required = requiredVotes(active, noCount);
  const contested = isContested(active, noCount);
  const yes = Math.max(int(yesCount) || 0, 0);
  const thresholdMet = yes >= required;

  // One effective merge clock, owned by whichever path applies:
  //   - threshold met → the fraction-based minimum visibility window
  //     (a brake on an already-approved proposal), or
  //   - threshold NOT met but lazy consensus armed → the count-based lazy
  //     window (an alternative path: elapsing MERGES the proposal).
  // Serialized as one windowEndsAt so every consumer (merge routes, sweeper,
  // countdown pill) reads a single timestamp regardless of which path armed.
  const lazyMs = lazyWindowMs(active, yesCount, noCount);
  const lazyArmed = !thresholdMet && lazyMs !== null;
  const windowMs = thresholdMet ? mergeWindowMs(active, yesCount, noCount)
    : lazyArmed ? lazyMs! : 0;
  const windowElapsed = windowMs <= 0 || nowMs - openedMs >= windowMs;
  const windowEndsAt = windowMs > 0 ? new Date(openedMs + windowMs).toISOString() : null;

  // Auto-takedown side, anchored on the same openedAt as the merge window.
  const rejWindowMs = rejectionWindowMs(active, yesCount, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const rejectionElapsed = rejectionArmed && nowMs - openedMs >= rejWindowMs!;
  const rejectionEndsAt = rejectionArmed
    ? new Date(openedMs + rejWindowMs!).toISOString()
    : null;

  return {
    required,
    windowMs,
    windowEndsAt,
    contested,
    thresholdMet,
    windowElapsed,
    // Lazy consensus (below-threshold merge clock).
    lazyArmed,
    lazyWindowMs: lazyArmed ? lazyMs : null,
    mergeable: (thresholdMet || lazyArmed) && windowElapsed,
    // Rejection (auto-takedown) fields.
    rejectionWindowMs: rejWindowMs,
    rejectionArmed,
    rejectionEndsAt,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

// ── Per-app governance (issue #646) ─────────────────────────────────────
//
// Three regimes, combined from the two dapp.json settings
// (apps.approver_policy / apps.approvals_required):
//   1. 'anyone' + no count: the dynamic time-&-majority gate (mergeGate)
//      over the active-user electorate, counting every vote.
//   2. 'invited' + no count: the same mergeGate math with the electorate
//      swapped for the approver members.
//   3. approvals_required=N ("at least N", either policy): mergeable as soon
//      as it has N qualifying yes votes (atLeastGate).
//   4. #4666: a project whose dapp.json names a `preset` or `rules`
//      (governance-rules.ts) is decided by those rules instead of the two
//      columns (computeRulesGate). Stored in apps.governance_rules; null
//      keeps regimes 1-3.

export interface StoredGroup { name: string; key: string; people: string[]; ids: number[] }
export interface StoredRules { preset: PresetKey | null; groups: StoredGroup[]; rules: Rule[] }

export interface Governance {
  approverPolicy: 'anyone' | 'invited';
  approvalsRequired: number | null;
  rules?: StoredRules | null;
}

// apps.governance_rules as the gate reads it: `{ preset, groups, rules }`,
// each group `{ name, key, people, ids }`, or null for anything unusable.
export function rulesFromColumn(raw: unknown): StoredRules | null {
  let v: any = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.rules) || !v.rules.length) return null;
  const groups: StoredGroup[] = Array.isArray(v.groups) ? v.groups.filter((g: any) => g && typeof g.name === 'string').map((g: any) => ({
    name: g.name,
    key: groupKey(g.name),
    people: Array.isArray(g.people) ? g.people.filter((p: unknown) => typeof p === 'string') : [],
    ids: Array.isArray(g.ids) ? g.ids.map((id: unknown) => parseInt(String(id), 10)).filter(Number.isFinite) : [],
  })) : [];
  const keys = new Set(groups.map((g) => g.key));
  const rules: Rule[] = v.rules.filter((r: any) => r && typeof r.group === 'string'
    && ['atLeast', 'percentOfActive', 'percentOfEveryone', 'majority'].includes(r.kind)
    && (BUILT_IN_GROUPS.includes(r.group) || keys.has(r.group)))
    .map((r: any) => {
      const rule: Rule = { group: r.group, kind: r.kind, n: r.kind === 'majority' ? null : parseInt(r.n, 10) || 1 };
      // A minimum a rule cannot take is dropped, as an unreadable rule is.
      const min = r.min != null && r.kind !== 'atLeast' ? parseInt(r.min, 10) : NaN;
      return Number.isFinite(min) && min >= 1 ? { ...rule, min } : rule;
    });
  if (!rules.length) return null;
  const preset = typeof v.preset === 'string' && (PRESET_KEYS as readonly string[]).includes(v.preset) ? v.preset as PresetKey : null;
  return { preset, groups, rules };
}

// The governance columns of an apps row, as readGovernance returns them.
// A row that carries governance_rules (the workflow machine's facts read)
// brings its rules too.
export function governanceFromRow(
  row: { approver_policy?: string | null; approvals_required?: Count; governance_rules?: unknown } | null | undefined,
): Governance {
  return {
    approverPolicy: row?.approver_policy === 'invited' ? 'invited' : 'anyone',
    approvalsRequired: row?.approvals_required != null
      ? int(row.approvals_required)
      : null,
    rules: row && Object.prototype.hasOwnProperty.call(row, 'governance_rules')
      ? rulesFromColumn(row.governance_rules) : null,
  };
}

export interface AppMeta { selfHosted: boolean; collabPrivate: boolean }

// What the vote denominator needs from an apps row (self_hosted,
// collab_visibility), for a caller that has the row already.
export function appMetaFromRow(row: { self_hosted?: unknown; collab_visibility?: string | null } | null | undefined): AppMeta {
  return {
    selfHosted: !!row?.self_hosted,
    collabPrivate: row?.collab_visibility === 'private',
  };
}

// Pure "at least N" gate, shaped exactly like mergeGate's return so
// every consumer (merge routes, sweeper, countdown pill) reads one
// object regardless of mode. Every MERGE clock is off by design: no
// visibility window, no lazy consensus, no contested state; N approvals
// and nothing else opens the merge.
//
// #2494: the REJECTION clock is no longer off with them. It was, and the
// consequence was that a promoted proposal on an at-least-N app could
// never close itself however it was voted: `server.js` archives on
// `gate.rejectable`, and this gate could not produce a true one.
//
// The rule is the default mode's, unchanged: same `REJECT_MIN_NO` floor,
// same dominance curve, same window (oppositionWindowMs). Only the
// KEEP-ALIVE differs, because the two modes measure support differently:
// the default mode protects a proposal whose Yes share of active users
// clears a fraction; at-least-N has no active denominator, and its own
// measure of support is the threshold itself. A proposal with its
// approvals is mergeable, so it must never auto-close.
//
// WHAT THIS DOES NOT DO, because it is the group's decision and not
// this function's: expire a proposal for AGE. A tie is still a stalemate
// in both modes (`no <= yes` never arms), so a 2-2 proposal still sits
// there.
export function atLeastGate(
  n: Count, yesCount: Count, noCount: Count = 0, openedAt: Instant = null, now: Instant = Date.now(),
  opts: { floorMet?: boolean } = {},
  opposition: (yes: Count, no: Count) => number | null = oppositionWindowMs,
): Gate {
  const yes = Math.max(int(yesCount) || 0, 0);
  const required = Math.max(int(n) || 1, 1);
  const thresholdMet = yes >= required;
  // The member floor (applyNoTimerMerge below): a flagged proposal whose
  // only qualifying Yes is its author's is not mergeable however many
  // approvals the count shows. `floorMet` defaults to true, so every caller
  // that is not flagged keeps exactly the old gate.
  const floorMet = opts.floorMet !== false;
  const mergeable = thresholdMet && floorMet;
  // Keep-alive: a proposal that already has its approvals is mergeable,
  // and must not be auto-rejected out from under them. Keyed on MERGEABLE,
  // not on the count: an author's own Yes on a flagged proposal is not
  // support the floor accepts, so it must not keep a proposal the group is
  // voting down alive forever either.
  const rejWindowMs = mergeable ? null : opposition(yes, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const openedMs = openedAt ? new Date(openedAt).getTime() : NaN;
  // A NULLISH `now` means "now", not the epoch. The default parameter only
  // covers `undefined`, and routes/votes.js passes an explicit `null` here
  // to reach the options argument: `new Date(null).getTime()` is 0, which
  // would put every proposal's clock fifty-six years in the future and
  // report `rejectable: false` forever.
  const nowMs = now == null
    ? Date.now()
    : (typeof now === 'number' ? now : new Date(now).getTime());
  // An unknown open time cannot be elapsed. `rejectionEndsAt` must not
  // become `new Date(NaN)`: stay ARMED but not yet rejectable, the safe
  // direction for a proposal whose age we cannot establish.
  const rejectionElapsed = rejectionArmed
    && Number.isFinite(openedMs) && nowMs - openedMs >= rejWindowMs!;
  return {
    required,
    windowMs: 0,
    windowEndsAt: null,
    contested: false,
    thresholdMet,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable,
    rejectionWindowMs: rejWindowMs,
    rejectionArmed,
    rejectionEndsAt: rejectionArmed && Number.isFinite(openedMs)
      ? new Date(openedMs + rejWindowMs!).toISOString()
      : null,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

export interface Floor { applies: boolean; otherYes: number; met: boolean }

// #788 "explicit approval" modifier. A proposal whose diff changes a
// protected dapp.json block (admins, governance, visibility,
// platform_env, secrets; services/explicit-approval.js) keeps the app's
// NORMAL approval rules but loses every TIME-BASED merge path:
//   - the minimum visibility window is zeroed, so it merges the instant
//     its normal threshold is met by votes actually cast;
//   - lazy consensus is disarmed outright. Silence must never hand out
//     admin rights.
// Everything else passes through untouched: `required`, `contested`,
// `thresholdMet`, and all four rejection fields, so a flagged proposal
// nobody wants still dies on schedule.
//
// THE MEMBER FLOOR. `floor` (memberFloor below) adds one condition on
// top: whenever the community has more than one member, a flagged
// proposal also needs at least one qualifying Yes from someone other than
// its author. `floor` null means "not evaluated" (a display serializer
// that does not read it): the merge side then behaves as before.
export function applyNoTimerMerge<G extends Gate>(gate: G, floor: Floor | null = null): G {
  const floorMet = !floor || floor.met !== false;
  return {
    ...gate,
    windowMs: 0,
    windowEndsAt: null,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable: !!gate.thresholdMet && floorMet,
  };
}

// The member floor for one flagged proposal, from the community's member
// count and the qualifying Yes votes cast by someone other than the author.
// Returns null when the member count is unknown (not evaluated), else
// { applies, otherYes, met }: `applies` is false for a one-member
// community, where nobody else exists to ask, and `met` is true whenever
// the floor does not apply.
export function memberFloor({ memberCount, otherYes }: { memberCount?: Count; otherYes?: Count } = {}): Floor | null {
  if (memberCount === undefined || memberCount === null) return null;
  const members = int(memberCount);
  if (!Number.isFinite(members)) return null;
  const applies = members > 1;
  const other = Math.max(int(otherYes) || 0, 0);
  return { applies, otherYes: other, met: !applies || other >= 1 };
}

function instantMs(v: Instant): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// An admin's lone No (#5803): a change that one of the project's admins voted
// No on, and that nobody has voted Yes on, is set aside after
// ADMIN_NO_WINDOW_MS from that No. Pure, like its siblings: the clock is
// recomputed on every read, so nothing has to be cancelled.
//
// Cleared (returns the gate untouched) by:
//   - no admin No, or a protected settings change (`explicitApproval`: #788
//     keeps every time-based takedown off);
//   - any counted Yes, or a mergeable gate: a change with support is never
//     set aside;
//   - an admin No it cannot date.
// An opposition window (more No than Yes) that ends SOONER wins: the sooner
// time is the one the group already agreed to.
export function applyAdminNo<G extends Gate>(
  gate: G, adminNoAt: Instant, yesCount: Count, now: Instant,
  { explicitApproval = false }: { explicitApproval?: boolean } = {},
): G & { adminNo?: boolean } {
  return applyLoneNo(gate, adminNoAt, yesCount, now, ADMIN_NO_WINDOW_MS, 'adminNo', explicitApproval);
}

// An approver's lone No (#5947): the same rule over APPROVER_NO_WINDOW_MS,
// for a No from one of an invited project's approvers (pr-gate.ts
// approverNoAtSql). `yesCount` is the counted Yes, so an advisory Yes from
// someone who is not an approver does not stop the clock. When an admin's
// week is also armed, the sooner end wins, and the flag names the clock that
// ends it, so the machine closes with the reason that applies.
export function applyApproverNo<G extends Gate>(
  gate: G, approverNoAt: Instant, yesCount: Count, now: Instant,
  { explicitApproval = false }: { explicitApproval?: boolean } = {},
): G & { approverNo?: boolean } {
  return applyLoneNo(gate, approverNoAt, yesCount, now, APPROVER_NO_WINDOW_MS, 'approverNo', explicitApproval);
}

function applyLoneNo<G extends Gate>(
  gate: G, noAt: Instant, yesCount: Count, now: Instant,
  windowMs: number, flag: 'adminNo' | 'approverNo', explicitApproval: boolean,
): G & { adminNo?: boolean; approverNo?: boolean } {
  if (noAt == null || explicitApproval) return gate;
  if ((int(yesCount) || 0) > 0 || gate.mergeable) return gate;
  const noMs = instantMs(noAt);
  if (noMs == null) return gate;
  const nowMs = instantMs(now) ?? Date.now();
  const endsMs = noMs + windowMs;
  if (gate.rejectionArmed && gate.rejectionEndsAt) {
    const earlier = Date.parse(gate.rejectionEndsAt);
    if (Number.isFinite(earlier) && earlier <= endsMs) return gate;
  }
  // A clock this one overtakes no longer says why the change closes.
  const { adminNo: _admin, approverNo: _approver, ...rest } = gate as G & { adminNo?: boolean; approverNo?: boolean };
  return {
    ...(rest as G),
    rejectionWindowMs: windowMs,
    rejectionArmed: true,
    rejectionEndsAt: new Date(endsMs).toISOString(),
    rejectable: nowMs >= endsMs,
    [flag]: true,
  };
}

export interface GovernedGate extends Gate {
  policy: Governance['approverPolicy'];
  mode: 'at_least' | 'default' | 'rules';
  approvalsRequired: number | null;
  explicitApproval: boolean;
  memberFloor: Floor | null;
  qualifiedYes: number;
  qualifiedNo: number;
  activeCount: number;
  // A rules project's gate (computeRulesGate) adds these.
  preset?: PresetKey | null;
  whoDecides?: boolean;
  creatorYes?: boolean;
  partial?: boolean;
  passedBy?: { group: string; kind: string; n: number | null } | null;
  // #3800: the rule the proposal's yeses are counted against (evaluateRules'
  // `shown`), for the Votes card. Null while its group cannot be answered.
  shownRule?: { kind: string; n: number | null; electorate: number } | null;
  rules?: Array<{ group: string; kind: string; n: number | null; size: number; yes: number; need: number | null; passed: boolean; empty: boolean; min?: number }>;
  // Set (true) only when the first-version rule let it through
  // (applyFirstVersion); absent otherwise.
  firstVersion?: boolean;
  // Set (true) when the rejection clock is an admin's lone No (applyAdminNo),
  // so the machine closes with 'admin-no' rather than 'auto-rejected'.
  adminNo?: boolean;
  // The same for an approver's lone No (applyApproverNo): 'approver-no'.
  approverNo?: boolean;
}

// The two rules computeGate dispatches to. services/governance.js passes
// them as services/active-users.js exports them, so a test that stubs that
// module still reaches the gate it stubbed.
export interface GateRules {
  mergeGate: typeof mergeGate;
  oppositionWindowMs: typeof oppositionWindowMs;
}
const RULES: GateRules = { mergeGate, oppositionWindowMs };

export interface GateOpts {
  explicitApproval?: boolean;
  memberCount?: Count;
  otherYes?: Count;
  // #4666, a rules project: why it was flagged, the counted voters, the
  // author, and the app facts its rules read (governance.js rulesFacts).
  explicitReason?: string | null;
  voters?: { yes: Iterable<number> | Set<number>; no: Iterable<number> | Set<number> } | null;
  // The author, for the member floor only (a yes from someone else).
  // Proposing is never a yes (governance-rules.ts, "PROPOSING IS NOT A YES").
  authorId?: Count;
  rulesFacts?: RulesFacts | null;
  // The change is its project's first version (services/first-version-
  // rule.js): applyFirstVersion below.
  firstVersion?: boolean;
  // When one of the project's admins last cast a counted No on the current
  // version of the change (pr-gate.ts adminNoAtSql), or null. applyAdminNo
  // arms the week from it.
  adminNoAt?: Instant;
  // When one of an invited project's approvers last cast a counted No on it
  // (pr-gate.ts approverNoAtSql), or null. applyApproverNo arms its days.
  approverNoAt?: Instant;
}

// THE FIRST VERSION (13 Oct 2026, D1). A project made from a description
// has its first version built by Homeroom bot, and that version goes live
// without a vote once it has passed its review and its checks, for every
// audience (Just you, a private community, a public one). Run four's Club
// Votes was ready at 22:54 and waited all night for its maker's own yes,
// which nothing on the App tab let them give.
//
// So the vote is waived: the gate reads as approved (no yes needed, so the
// threshold is met; no clock; nothing to take it down) whatever the votes
// say, and `firstVersion` says why. `required` is 0, so every reader that
// compares the yes votes with it (the requirements ledger, the ready card's
// "how many more") sees nothing missing.
//
// It waives the VOTE and nothing else. Every gate evaluateMergeGate and the
// merge queue apply after the approvals step (the checks, the before &
// after shots, a locked app's admin yes, main's health, a conflict) still
// applies to it, and so does the protected-settings rule: a first version
// that changes who decides or the project's keys (`explicitApproval`) is
// decided by that rule as before. Every later change, the bot's included,
// goes to the vote.
export function applyFirstVersion<G extends Gate>(gate: G, { explicitApproval = false }: { explicitApproval?: boolean } = {}): G {
  if (explicitApproval) return gate;
  return {
    ...gate,
    required: 0,
    contested: false,
    thresholdMet: true,
    windowMs: 0,
    windowEndsAt: null,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable: true,
    rejectionWindowMs: null,
    rejectionArmed: false,
    rejectionEndsAt: null,
    rejectable: false,
    firstVersion: true,
  };
}

// Pure mode dispatch given already-resolved governance + counts.
//
// `opts.explicitApproval` layers the #788 no-timer modifier on top of
// whichever regime the app configured: `mode` still reports the real
// regime ('default' / 'at_least'), because the app's rules are what
// still decide the threshold.
//
// `opts.memberCount` + `opts.otherYes` evaluate the member floor for a
// flagged proposal (applyNoTimerMerge above); `memberFloor` on the result
// is null when the proposal is not flagged or the floor was not evaluated.
//
// `opts.firstVersion` waives the vote for a project's first version, in
// every regime (applyFirstVersion above).
//
// `opts.adminNoAt` arms a week-long takedown from an admin's lone No
// (applyAdminNo above), and `opts.approverNoAt` a shorter one from an
// approver's (applyApproverNo), before the first-version rule clears every rejection
// field. A rules project's "Yes" is the counted voters, when it has them.
export function computeGate(
  gov: Governance, active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant,
  opts: GateOpts = {},
  rules: GateRules = RULES,
): GovernedGate {
  const gate = gov && gov.rules
    ? computeRulesGate(gov, active, yesCount, noCount, openedAt, now, opts, rules)
    : computeColumnsGate(gov, active, yesCount, noCount, openedAt, now, opts, rules);
  const yesForClock = gov && gov.rules && opts.voters
    ? (opts.voters.yes instanceof Set
      ? opts.voters.yes.size : new Set(opts.voters.yes || []).size)
    : yesCount;
  // An approver is an invited project's (the roster electorate.ts reads); a
  // rules project's groups decide by their own rules, so no approver clock.
  const approverNoAt = gov && !gov.rules && gov.approverPolicy === 'invited' ? opts.approverNoAt ?? null : null;
  const timed = applyApproverNo(
    applyAdminNo(gate, opts.adminNoAt ?? null, yesForClock, now, { explicitApproval: !!opts.explicitApproval }),
    approverNoAt, yesForClock, now, { explicitApproval: !!opts.explicitApproval },
  );
  return opts.firstVersion ? applyFirstVersion(timed, { explicitApproval: !!opts.explicitApproval }) : timed;
}

// The two columns' regimes (default, at least N), with the #788 modifier.
function computeColumnsGate(
  gov: Governance, active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant,
  opts: GateOpts,
  rules: GateRules,
): GovernedGate {
  const explicitApproval = !!opts.explicitApproval;
  const floor = explicitApproval ? memberFloor(opts) : null;
  const base = gov.approvalsRequired != null
    ? atLeastGate(gov.approvalsRequired, yesCount, noCount, openedAt, now,
      { floorMet: !floor || floor.met }, rules.oppositionWindowMs)
    : rules.mergeGate(active, yesCount, noCount, openedAt, now);
  const gated = explicitApproval ? applyNoTimerMerge(base, floor) : base;
  return {
    ...gated,
    policy: gov.approverPolicy,
    mode: gov.approvalsRequired != null ? 'at_least' : 'default',
    approvalsRequired: gov.approvalsRequired,
    explicitApproval,
    memberFloor: floor,
    qualifiedYes: Math.max(int(yesCount) || 0, 0),
    qualifiedNo: Math.max(int(noCount) || 0, 0),
    activeCount: Math.max(int(active) || 0, 1),
  };
}

// #4666: whether a flagged proposal is a change to WHO DECIDES (who can see
// the project, its admins, its groups, its rule, the platform's settings) as
// opposed to a change to its keys. Who decides goes by WHO_DECIDES whatever
// the project picked; keys follow the project's own rule. A flag with no
// reason (a row stamped before reasons existed) is treated as who decides,
// the stricter reading.
export function isWhoDecidesReason(reason: string | null | undefined): boolean {
  return reason !== 'secrets';
}

// computeGate for a project with rules of its own (governance-rules.ts). The
// counts stand in for the members group when the caller has no voter sets
// (`opts.voters`) or app facts (`opts.rulesFacts`); a rule they cannot answer
// does not pass, and `partial` says so. Every path that decides goes through
// governance.js governedGate or the governance machine, which read both.
//
// Returns the mergeGate shape every consumer reads, plus `mode: 'rules'`,
// `preset`, `whoDecides`, `rules` (each rule's status), `passedBy` (the rule
// that let it in, or null) and `creatorYes`.
export function computeRulesGate(
  gov: Governance, active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant,
  opts: GateOpts = {},
  rules: GateRules = RULES,
): GovernedGate {
  const stored = gov.rules!;
  const explicitApproval = !!opts.explicitApproval;
  const whoDecides = explicitApproval && isWhoDecidesReason(opts.explicitReason ?? null);
  const value = whoDecides ? { rules: WHO_DECIDES } : stored;
  const facts: RulesFacts = opts.rulesFacts || {
    creatorId: null, memberCount: (opts.memberCount ?? 0) as number, membersActive: active as number,
    adminIds: [], groups: new Map(), activeIds: null,
  };
  const membersActive = Math.max(int(active) || 0, 1);
  const voters = opts.voters ? {
    yes: opts.voters.yes instanceof Set ? opts.voters.yes : new Set<number>(opts.voters.yes || []),
    no: opts.voters.no instanceof Set ? opts.voters.no : new Set<number>(opts.voters.no || []),
  } : null;
  const authorId = opts.authorId != null && Number.isFinite(int(opts.authorId))
    ? int(opts.authorId) : null;
  // The member floor on the majority rules of a flagged proposal: a yes from
  // someone other than its author, once the community has more than one member.
  let floor: Floor | null = null;
  if (explicitApproval) {
    const otherYes = voters
      ? [...voters.yes].filter((id) => id !== authorId).length
      : opts.otherYes;
    floor = memberFloor({ memberCount: opts.memberCount ?? facts.memberCount, otherYes });
  }
  const evaluated = evaluateRules({
    value,
    facts: { ...facts, membersActive },
    voters,
    counts: { yes: Math.max(int(yesCount) || 0, 0), no: Math.max(int(noCount) || 0, 0) },
    openedAt,
    now,
    noTimers: explicitApproval,
    memberFloor: floor,
    mergeGate: rules.mergeGate,
    applyNoTimerMerge,
    atLeastGate: (n, yes, no, opened, at) => atLeastGate(n, yes, no, opened, at, {}, rules.oppositionWindowMs),
  });
  const { gate, owner, shown, results, passedBy } = evaluated;
  // Only a Yes the creator cast: proposing is none (governance-rules.ts).
  const creatorYes = !!(facts.creatorId && voters && voters.yes.has(facts.creatorId));
  return {
    ...gate,
    policy: 'anyone',
    mode: 'rules',
    approvalsRequired: null,
    explicitApproval,
    // The floor is the group's side of a flagged change only: reported while
    // it is what holds the proposal, never once a rule has let it in.
    memberFloor: floor && !gate.mergeable ? floor : (floor ? { ...floor, applies: false, met: true } : null),
    qualifiedYes: shown.yes,
    qualifiedNo: owner.no,
    activeCount: membersActive,
    preset: whoDecides ? null : (stored.preset || matchPreset(stored.rules)),
    whoDecides,
    creatorYes,
    partial: evaluated.partial,
    passedBy: passedBy ? { group: passedBy.group, kind: passedBy.kind, n: passedBy.n } : null,
    shownRule: shown.known
      ? { kind: shown.kind, n: shown.n, electorate: shown.electorate } : null,
    rules: results.map((r) => ({
      group: r.group, kind: r.kind, n: r.n, size: r.size, yes: r.yes, need: r.need,
      passed: r.passed, empty: r.empty,
      ...(r.min != null ? { min: r.min } : {}),
    })),
  };
}
