// The one copy of the approval rules: services/governance-rules.js
// re-exports this module, and the governance machine decides with it.

/**
 * WHO SAYS YES (#4666): a project's approval rule as named presets, or as
 * groups and rules of its own. Pure: nothing here reads the database, so
 * every rule is tested without one (tests/governance-rules.test.js).
 * services/governance.js and the governance machine read the facts and
 * hand them in.
 *
 * ── The block ──────────────────────────────────────────────────────────
 *
 * dapp.json's `governance` block gains three keys beside the two it always
 * had (`approvers`, `approvals`, read by app-manifest.js readGovernance):
 *
 *   "governance": { "preset": "you_or_the_group" }
 *
 *   "governance": {
 *     "groups": [{ "name": "Lifeguards", "people": ["evan", "maya"] }],
 *     "rules": [
 *       { "group": "creator", "atLeast": 1 },
 *       { "group": "Lifeguards", "atLeast": 2 },
 *       { "group": "members", "percentOfActive": 50 },
 *       { "group": "members", "percentOfEveryone": 60 },
 *       { "group": "members", "majority": true }
 *     ]
 *   }
 *
 * A change goes live when ANY rule passes. A preset is a name for a rule
 * list (PRESETS); `preset` and `rules` are two spellings of the same thing,
 * and a block that has either is a "rules" block: the old two keys are then
 * ignored, and a project without one keeps exactly the rule it had.
 *
 * ── Groups ─────────────────────────────────────────────────────────────
 *
 * Three are built in: `creator` (the person who made the project; nobody on
 * the platform's own app, which has no creator), `members` (everyone in its
 * community) and `admins` (dapp.json's `admins`). A named group is a list of
 * people, by username, so changing who is in it is a change to dapp.json
 * like any other, and a protected one (below). A rule on a group with nobody
 * in it never passes.
 *
 * ── Rules ──────────────────────────────────────────────────────────────
 *
 * One measure each:
 *
 *   atLeast N            N yeses from the group, never more than it has, so
 *                        a group that shrinks never makes the rule
 *                        impossible;
 *   percentOfActive P    P% of the group's people who have been around
 *                        lately (the platform's own "active"), at least one;
 *   percentOfEveryone P  P% of everyone in the group, active or not;
 *   majority             the platform's time-and-majority vote
 *                        (active-users.js mergeGate) over the group: the
 *                        eased threshold, the minimum window and the quiet
 *                        wait, exactly as Group vote has always worked.
 *
 * A majority or percentage rule can also carry a `minimum`, the fewest
 * yeses it passes on:
 *
 *   { "group": "members", "majority": true, "minimum": 10 }
 *
 * "Most active people in All members say yes, over time, and at least 10 of
 * them": the rule passes when its measure does AND the yeses reach the
 * minimum, on the quiet wait too, so silence alone never ships a change in a
 * small group. The minimum counts the yeses its own rule counts (votes as
 * cast on majority, proposing included on a percentage; below) and is never
 * more than the group has, so a group that shrinks never makes the rule
 * impossible. An atLeast rule takes none: it is one already.
 *
 * Only yeses count toward a rule; a No still does what it always did on the
 * majority rule (raises the bar, arms the takedown clock).
 *
 * PROPOSING COUNTS AS A YES on the counted rules (atLeast and the two
 * percentages): a person who opens a change is saying yes to it, so the
 * author's yes is counted unless they voted No. That is what makes Two yeses
 * "whoever makes it, plus one more", Open floor "any member's yes, even their
 * own" and You or the group "you ship on your own". The majority rule counts
 * votes as they are cast, so Group vote is today's default to the vote.
 *
 * Only a PERSON's proposing is a yes. A change Homeroom bot made from
 * somebody's suggestion has the bot as its author (an account the platform
 * runs, users.is_synthetic; `authorIsBot`), and nobody has said yes to it
 * yet: on every rule it needs a person's yes like any other vote (13 Oct
 * 2026, D2: on Open floor the bot's change used to go live as soon as its
 * checks passed, with nobody asked). The one change that skips the vote is a
 * project's first version, and that is the gate's rule, not this one
 * (governance-gate.ts applyFirstVersion).
 *
 * Only proposing ON HOMEROOM is a yes. A change a coding agent submitted for
 * its author (through the connector, or a local agent's hand-off:
 * chat_sessions.external_agent; `madeByAgent`) was put up for a vote by the
 * agent, not by the person tapping anything here. Its author's yes counts
 * like anyone's, once they tap Yes on it (29 Oct 2026: "they should just have
 * to manually do it, not have it auto-done by the connector").
 *
 * An author who TOOK THEIR VOTE BACK on this version has no yes for
 * proposing (`authorWithdrew`, chat_sessions.author_yes_withdrawn_epoch
 * matching the current epoch): they said no to counting it. A new version
 * (an epoch bump) counts proposing as their yes again.
 *
 * ── Changes to who decides ─────────────────────────────────────────────
 *
 * A change to who can see the project, its admins, its groups or this rule
 * (a proposal flagged for explicit approval with any reason but `secrets`;
 * services/explicit-approval.js) is decided by WHO_DECIDES whatever the
 * project picked: the creator's yes, or the group's majority by votes
 * actually cast. No quiet wait, no minimum window, and the member floor (a
 * yes from someone besides its author) on the group's side. The creator has
 * no veto: the group's majority can still outvote them, as it always could,
 * so no project can end up in a state its members cannot change.
 *
 * A change to the project's keys (`secrets`) follows the project's own rule,
 * with the clocks off and the member floor on any majority rule.
 */


import type { Gate, Floor } from './governance-gate.ts';

export const PRESET_KEYS = Object.freeze(['you_or_the_group', 'two_yeses', 'open_floor', 'group_vote'] as const);
export type PresetKey = typeof PRESET_KEYS[number];
export const DEFAULT_PRESET: PresetKey = 'you_or_the_group';

export const BUILT_IN_GROUPS: readonly string[] = Object.freeze(['creator', 'members', 'admins']);
const MEASURES = Object.freeze(['atLeast', 'percentOfActive', 'percentOfEveryone', 'majority'] as const);
export type Measure = typeof MEASURES[number];

export const MAX_RULES = 5;
export const MAX_GROUPS = 10;
export const MAX_GROUP_PEOPLE = 50;
export const MAX_AT_LEAST = 50;
// A minimum of one says nothing: every rule already needs a yes.
export const MIN_MINIMUM = 2;
export const GROUP_NAME_MAX = 32;
const USERNAME_MAX = 64;

/**
 * One rule, normalised: `group` is a built-in key or a named group's key; `n`
 * is null for majority; `min`, on a majority or percentage rule that has one,
 * is the fewest yeses it passes on (absent when it has none).
 */
export interface Rule { group: string; kind: Measure; n: number | null; min?: number | null }
export interface Group { name: string; people: string[] }
export interface RulesValue { preset: PresetKey | null; groups: Group[]; rules: Rule[] }

/** Each preset, as the rules it stands for. */
export const PRESETS: Readonly<Record<PresetKey, readonly Rule[]>> = Object.freeze({
  you_or_the_group: Object.freeze([
    Object.freeze({ group: 'creator', kind: 'atLeast', n: 1 }),
    Object.freeze({ group: 'members', kind: 'majority', n: null }),
  ]),
  two_yeses: Object.freeze([Object.freeze({ group: 'members', kind: 'atLeast', n: 2 })]),
  open_floor: Object.freeze([Object.freeze({ group: 'members', kind: 'atLeast', n: 1 })]),
  group_vote: Object.freeze([Object.freeze({ group: 'members', kind: 'majority', n: null })]),
} as const);

/** The rule every change to who decides goes by. */
export const WHO_DECIDES = PRESETS.you_or_the_group;

/** Human names, for PR titles and the notices panel. */
export const PRESET_NAMES: Readonly<Record<PresetKey, string>> = Object.freeze({
  you_or_the_group: 'You or the group',
  two_yeses: 'Two yeses',
  open_floor: 'Open floor',
  group_vote: 'Group vote',
});

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isPresetKey(v: unknown): v is PresetKey {
  return typeof v === 'string' && (PRESET_KEYS as readonly string[]).includes(v);
}

/** A named group's key: its name, case-folded and with spaces collapsed. */
export function groupKey(name: unknown): string {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanName(name: unknown): string {
  return String(name || '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

function cleanUsername(raw: unknown): string {
  return String(raw || '').trim().replace(/^@/, '');
}

/**
 * One group from dapp.json, or throw. People are kept as written (order and
 * case), less blanks and repeats.
 */
function parseGroup(raw: unknown, i: number): Group {
  if (!isPlainObject(raw)) throw new RulesError(`governance.groups[${i}] must be an object`);
  const name = cleanName(raw.name);
  if (!name) throw new RulesError(`governance.groups[${i}] needs a name`);
  if (name.length > GROUP_NAME_MAX) throw new RulesError(`A group's name is at most ${GROUP_NAME_MAX} characters`);
  if (BUILT_IN_GROUPS.includes(groupKey(name))) {
    throw new RulesError(`"${name}" is a built-in group; name yours something else`);
  }
  const people = raw.people == null ? [] : raw.people;
  if (!Array.isArray(people)) throw new RulesError(`governance.groups[${i}].people must be a list of usernames`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of people) {
    if (typeof p !== 'string') throw new RulesError(`governance.groups[${i}].people must be a list of usernames`);
    const u = cleanUsername(p);
    if (!u) continue;
    if (u.length > USERNAME_MAX) throw new RulesError(`@${u.slice(0, 24)}… is not a username`);
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  if (out.length > MAX_GROUP_PEOPLE) throw new RulesError(`A group holds at most ${MAX_GROUP_PEOPLE} people`);
  return { name, people: out };
}

/**
 * One rule from dapp.json, normalised to `{ group, kind, n }` (`group` is a
 * built-in key or a named group's key; `n` is null for majority), or throw.
 */
function parseRule(raw: unknown, i: number, groupKeys: Set<string>): Rule {
  if (!isPlainObject(raw)) throw new RulesError(`governance.rules[${i}] must be an object`);
  const g = typeof raw.group === 'string' ? groupKey(raw.group) : '';
  if (!g) throw new RulesError(`governance.rules[${i}] needs a group`);
  if (!BUILT_IN_GROUPS.includes(g) && !groupKeys.has(g)) {
    throw new RulesError(`governance.rules[${i}] names a group that is not in governance.groups: "${raw.group}"`);
  }
  const present = MEASURES.filter((m) => raw[m] != null);
  if (present.length !== 1) {
    throw new RulesError(`governance.rules[${i}] needs exactly one of atLeast, percentOfActive, percentOfEveryone or majority`);
  }
  const kind = present[0];
  const v = raw[kind];
  const min = parseMinimum(raw.minimum, kind, i);
  const withMin = (rule: Rule): Rule => (min != null ? { ...rule, min } : rule);
  if (kind === 'majority') {
    if (v !== true) throw new RulesError(`governance.rules[${i}].majority must be true`);
    return withMin({ group: g, kind, n: null });
  }
  if (kind === 'atLeast') {
    if (!Number.isInteger(v) || v < 1 || v > MAX_AT_LEAST) {
      throw new RulesError(`governance.rules[${i}].atLeast must be a whole number from 1 to ${MAX_AT_LEAST}`);
    }
    return { group: g, kind, n: v };
  }
  if (!Number.isInteger(v) || v < 1 || v > 100) {
    throw new RulesError(`governance.rules[${i}].${kind} must be a whole number from 1 to 100`);
  }
  return withMin({ group: g, kind, n: v });
}

/** A rule's `minimum`, or null when it has none; throws on one it cannot take. */
function parseMinimum(v: unknown, kind: Measure, i: number): number | null {
  if (v == null) return null;
  if (kind === 'atLeast') {
    throw new RulesError(`governance.rules[${i}].minimum goes with majority or a percentage; atLeast is a minimum already`);
  }
  if (!Number.isInteger(v) || (v as number) < MIN_MINIMUM || (v as number) > MAX_AT_LEAST) {
    throw new RulesError(`governance.rules[${i}].minimum must be a whole number from ${MIN_MINIMUM} to ${MAX_AT_LEAST}`);
  }
  return v as number;
}

/**
 * The rules half of a dapp.json governance block, strictly: returns null when
 * the block has neither `preset` nor `rules` (it is an old-style block, or
 * none), else `{ preset, groups, rules }` with `preset` null for rules of a
 * project's own. Throws RulesError on anything it cannot read.
 */
export function parseRulesBlock(raw: unknown): RulesValue | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) throw new RulesError('governance must be an object');
  const hasPreset = raw.preset != null;
  const hasRules = raw.rules != null;
  if (!hasPreset && !hasRules) {
    if (raw.groups != null) throw new RulesError('governance.groups needs governance.rules beside it');
    return null;
  }
  if (hasPreset && hasRules) throw new RulesError('governance takes a preset or rules, not both');
  if (hasPreset) {
    if (!isPresetKey(raw.preset)) {
      throw new RulesError(`governance.preset must be one of ${PRESET_KEYS.join(', ')}`);
    }
    if (raw.groups != null) throw new RulesError('governance.groups goes with governance.rules, not a preset');
    return { preset: raw.preset, groups: [], rules: PRESETS[raw.preset].map((r) => ({ ...r })) };
  }
  const groupsRaw = raw.groups == null ? [] : raw.groups;
  if (!Array.isArray(groupsRaw)) throw new RulesError('governance.groups must be a list');
  if (groupsRaw.length > MAX_GROUPS) throw new RulesError(`A project has at most ${MAX_GROUPS} groups of its own`);
  const groups = groupsRaw.map(parseGroup);
  const keys = new Set<string>();
  for (const g of groups) {
    const k = groupKey(g.name);
    if (keys.has(k)) throw new RulesError(`Two groups are called "${g.name}"`);
    keys.add(k);
  }
  if (!Array.isArray(raw.rules)) throw new RulesError('governance.rules must be a list');
  if (!raw.rules.length) throw new RulesError('governance.rules needs at least one rule');
  if (raw.rules.length > MAX_RULES) throw new RulesError(`A project has at most ${MAX_RULES} rules`);
  const rules = raw.rules.map((r: unknown, i: number) => parseRule(r, i, keys));
  const seenRule = new Set<string>();
  for (const r of rules) {
    const k = ruleSignature(r);
    if (seenRule.has(k)) throw new RulesError('The same rule is listed twice');
    seenRule.add(k);
  }
  return { preset: null, groups, rules };
}

/**
 * The same read, leniently, for the deploy-time reader: a block it cannot
 * read is reported and left out (`{ value: null, error }`), never thrown, so
 * a typo in dapp.json can never fail a deploy. The caller keeps the rule the
 * project already has.
 */
export function readRulesBlock(raw: unknown): { value: RulesValue | null; error: string | null } {
  try {
    return { value: parseRulesBlock(raw), error: null };
  } catch (err) {
    if (err instanceof RulesError) return { value: null, error: err.message };
    throw err;
  }
}

// A rule without a minimum keeps the signature it always had.
function ruleSignature(r: Rule): string {
  const min = r.kind !== 'atLeast' && r.min != null ? `:min${r.min}` : '';
  return `${r.group}:${r.kind}:${r.kind === 'majority' ? '' : r.n}${min}`;
}

/** The preset a rule list is the same as, or null. Order does not matter. */
export function matchPreset(rules: readonly Rule[] | null | undefined): PresetKey | null {
  if (!Array.isArray(rules) || !rules.length) return null;
  const sig = rules.map(ruleSignature).sort().join('|');
  for (const key of PRESET_KEYS) {
    if (PRESETS[key].map(ruleSignature).sort().join('|') === sig) return key;
  }
  return null;
}

/**
 * The dapp.json block for a rules value (`{ preset }` or `{ groups, rules }`),
 * canonical: a rule list that is a preset, with no groups of its own, is
 * written as the preset. Every group is written, including one no rule
 * names yet: its people are still a choice somebody made.
 */
export function blockFor({ preset = null, groups = [], rules = [] }: Partial<RulesValue> = {}): Record<string, unknown> {
  const same = preset || (groups.length ? null : matchPreset(rules));
  if (same) return { preset: same };
  const nameOf = new Map(groups.map((g) => [groupKey(g.name), g.name]));
  const out: Record<string, unknown> = {};
  if (groups.length) out.groups = groups.map((g) => ({ name: g.name, people: [...g.people] }));
  out.rules = rules.map((r) => {
    const group = BUILT_IN_GROUPS.includes(r.group) ? r.group : (nameOf.get(r.group) || r.group);
    const rule: Record<string, unknown> = r.kind === 'majority' ? { group, majority: true } : { group, [r.kind]: r.n };
    if (r.min != null && r.kind !== 'atLeast') rule.minimum = r.min;
    return rule;
  });
  return out;
}

/**
 * A rules value as apps.governance_rules stores it, given each named group's
 * resolved user ids (`idsByGroup`: group key -> ids; app-manifest.js
 * storedRules resolves them). A preset has no groups, so it needs none.
 */
export function storedForm(value: Partial<RulesValue>, idsByGroup: Map<string, number[]> = new Map()) {
  return {
    preset: value.preset || null,
    groups: (value.groups || []).map((g) => ({
      name: g.name,
      people: [...(g.people || [])],
      ids: [...(idsByGroup.get(groupKey(g.name)) || [])],
    })),
    rules: (value.rules || []).map((r) => ({
      group: r.group, kind: r.kind, n: r.kind === 'majority' ? null : r.n,
      ...(r.min != null && r.kind !== 'atLeast' ? { min: r.min } : {}),
    })),
  };
}

// ── Saying the rules in words ───────────────────────────────────────────
//
// The sheet's wording (frontend/locales/en/dialogs.json, whoDecides.rule.
// phrase.*), so a change's title and description say what the rule screen
// says. Pure: `groups` is the value's own `{ name, people }` list (or a
// stored group, matched by groupKey).

/** A rule's group, in the sheet's words: "the creator", "All members", "App admins", a name. */
export function groupLabel(key: string, groups: readonly Group[] = []): string {
  if (key === 'creator') return 'the creator';
  if (key === 'members') return 'All members';
  if (key === 'admins') return 'App admins';
  const g = groups.find((x) => groupKey(x.name) === key);
  return g ? g.name : key;
}

/** A rule as a title names it: "the creator's yes", "2 yeses from Lifeguards", "a vote of All members". */
export function ruleShort(rule: Rule, groups: readonly Group[] = []): string {
  const g = groupLabel(rule.group, groups);
  if (rule.kind === 'atLeast') {
    if (rule.group === 'creator' && rule.n === 1) return "the creator's yes";
    return rule.n === 1 ? `1 yes from ${g}` : `${rule.n} yeses from ${g}`;
  }
  if (rule.kind === 'percentOfActive') return `${rule.n}% of active ${g}`;
  if (rule.kind === 'percentOfEveryone') return `${rule.n}% of ${g}`;
  return `a vote of ${g}`;
}

/** A rule as a sentence, as the rule screen says it, with no full stop. */
export function ruleSentence(rule: Rule, groups: readonly Group[] = []): string {
  const g = groupLabel(rule.group, groups);
  let sentence: string;
  if (rule.kind === 'atLeast') {
    if (rule.group === 'creator' && rule.n === 1) sentence = 'The creator says yes';
    else if (rule.n === 1) sentence = `At least 1 person in ${g} says yes`;
    else sentence = `At least ${rule.n} people in ${g} say yes`;
  } else if (rule.kind === 'percentOfActive') {
    sentence = `${rule.n}% of the active people in ${g} say yes`;
  } else if (rule.kind === 'percentOfEveryone') {
    sentence = `${rule.n}% of everyone in ${g} says yes`;
  } else {
    sentence = `Most active people in ${g} say yes, over time`;
  }
  if (rule.kind !== 'atLeast' && rule.min != null) sentence += `, and at least ${rule.min} of them`;
  return sentence;
}

function joinOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

// A title reads a list of short rules; past this it names the first two.
const OR_LIST_LIMIT = 90;

export interface RulesInFull { sentences: string[]; groups: Group[] }

/** Every rule as a sentence, and every named group with its people. */
export function describeRulesInFull(value: Partial<RulesValue> | null | undefined): RulesInFull {
  if (!value) return { sentences: [], groups: [] };
  const groups = value.groups || [];
  const preset = value.preset || matchPreset(value.rules);
  const rules = preset ? PRESETS[preset].map((r) => ({ ...r })) : (value.rules || []);
  return { sentences: rules.map((r) => `${ruleSentence(r, groups)}.`), groups: [...groups] };
}

export interface RulesDiff {
  added: Rule[];
  removed: Rule[];
  groupsAdded: Group[];
  groupsRemoved: Group[];
  peopleChanged: { name: string; added: string[]; removed: string[] }[];
}

function rulesOf(value: { preset?: PresetKey | null; rules?: readonly Rule[] } | null | undefined): Rule[] {
  if (!value) return [];
  if (value.preset) return PRESETS[value.preset].map((r) => ({ ...r }));
  return [...(value.rules || [])];
}

/**
 * What a new rules value changes against today's (`was`, a stored rules
 * value or null). Rules compare by signature, groups by groupKey, people
 * case-insensitively. Null when there is no today to compare with.
 */
export function diffRules(
  was: { preset?: PresetKey | null; groups?: readonly Group[]; rules?: readonly Rule[] } | null | undefined,
  now: Partial<RulesValue>,
): RulesDiff | null {
  if (!was) return null;
  const wasRules = rulesOf(was);
  const nowRules = rulesOf(now);
  const wasSignatures = new Set(wasRules.map(ruleSignature));
  const nowSignatures = new Set(nowRules.map(ruleSignature));
  const wasGroups = was.groups || [];
  const nowGroups = now.groups || [];
  const wasByKey = new Map(wasGroups.map((g) => [groupKey(g.name), g]));
  const nowByKey = new Map(nowGroups.map((g) => [groupKey(g.name), g]));
  const peopleChanged: RulesDiff['peopleChanged'] = [];
  for (const g of nowGroups) {
    const before = wasByKey.get(groupKey(g.name));
    if (!before) continue;
    const wasPeople = new Set(before.people.map((p) => p.toLowerCase()));
    const nowPeople = new Set(g.people.map((p) => p.toLowerCase()));
    const added = g.people.filter((p) => !wasPeople.has(p.toLowerCase()));
    const removed = before.people.filter((p) => !nowPeople.has(p.toLowerCase()));
    if (added.length || removed.length) peopleChanged.push({ name: g.name, added, removed });
  }
  return {
    added: nowRules.filter((r) => !wasSignatures.has(ruleSignature(r))),
    removed: wasRules.filter((r) => !nowSignatures.has(ruleSignature(r))),
    groupsAdded: nowGroups.filter((g) => !wasByKey.has(groupKey(g.name))),
    groupsRemoved: wasGroups.filter((g) => !nowByKey.has(groupKey(g.name))),
    peopleChanged,
  };
}

/**
 * "You or the group" for a preset; a project's own rules as their short
 * list ("the creator's yes, or a vote of All members"), the first two when
 * that is longer than a title.
 */
export function describeRules(value: Partial<RulesValue> | null | undefined): string {
  if (!value) return 'the default time-&-majority vote';
  const groups = value.groups || [];
  const preset = value.preset || matchPreset(value.rules);
  if (preset && !groups.length) return PRESET_NAMES[preset];
  const rules = value.rules || [];
  if (!rules.length) return 'its own rules';
  const parts = rules.map((r) => ruleShort(r, groups));
  const joined = joinOr(parts);
  if (joined.length > OR_LIST_LIMIT && parts.length > 2) {
    const more = parts.length - 2;
    return `${parts.slice(0, 2).join(', ')}, or ${more} more rule${more === 1 ? '' : 's'}`;
  }
  return joined;
}

// ── Evaluation ──────────────────────────────────────────────────────────

/** What governance.js rulesFacts (or the governance machine) read about the app. */
export interface RulesFacts {
  creatorId: number | null;
  memberCount: number | string;
  membersActive: number | string;
  adminIds: number[];
  groups: Map<string, number[]>;
  activeIds: Set<number> | null;
}
export interface Voters { yes: Set<number>; no: Set<number> }

interface Tally { size: number; yes: number; no: number; active: number; ids: number[] | null; known: boolean }

/**
 * A group's people and the votes from them, for one proposal. `facts` is
 * what governance.js read about the app (rulesFacts):
 *
 *   creatorId     the creator, or null (nobody: the platform's own app, or
 *                 a deleted account);
 *   memberCount   people in its community;
 *   membersActive the active-member electorate (getActiveUserStats), >= 1;
 *   adminIds      app admins;
 *   groups        Map of named-group key -> user ids;
 *   activeIds     Set of active people, or null when not read (then a named
 *                 group's active count is its size).
 *
 * `voters` is `{ yes: Set, no: Set }` of the counted votes' user ids, or
 * null when the caller has only counts (`counts`: { yes, no }), which can
 * answer the members group and nothing else.
 */
function groupTally(group: string, { facts, voters, counts }: Pick<EvalContext, 'facts' | 'voters' | 'counts'>): Tally {
  if (group === 'members') {
    const size = Math.max(parseInt(String(facts.memberCount), 10) || 0, 0);
    return {
      size,
      // Every counted vote, as Group vote always counted them: writing a
      // vote already requires membership (communities.requireSessionMembership).
      yes: voters ? voters.yes.size : (counts.yes || 0),
      no: voters ? voters.no.size : (counts.no || 0),
      active: Math.max(parseInt(String(facts.membersActive), 10) || 0, 1),
      ids: null,
      known: true,
    };
  }
  let ids: number[];
  if (group === 'creator') ids = facts.creatorId ? [facts.creatorId] : [];
  else if (group === 'admins') ids = facts.adminIds || [];
  else ids = (facts.groups && facts.groups.get(group)) || [];
  const uniq = [...new Set(ids)];
  if (!voters) return { size: uniq.length, yes: 0, no: 0, active: uniq.length, ids: uniq, known: false };
  const active = facts.activeIds ? uniq.filter((id) => facts.activeIds!.has(id)).length : uniq.length;
  return {
    size: uniq.length,
    yes: uniq.filter((id) => voters.yes.has(id)).length,
    no: uniq.filter((id) => voters.no.has(id)).length,
    active,
    ids: uniq,
    known: true,
  };
}

/** Whether the author belongs to the group, for the counted yes. */
function authorIn(group: string, tally: Tally, authorId: number | null): boolean {
  if (authorId == null) return false;
  if (group === 'members') return true;
  return !!tally.ids && tally.ids.includes(authorId);
}

export interface EvalContext {
  facts: RulesFacts;
  voters: Voters | null;
  counts: { yes: number; no: number };
  authorId: number | null;
  // The author is an account the platform runs (Homeroom bot): proposing is
  // not a person's yes, so it counts for nothing (see the header).
  authorIsBot?: boolean;
  // A coding agent submitted the change (see the header): the author's yes
  // counts once they tap it, not for proposing.
  madeByAgent?: boolean;
  // The author took their own vote back on this version (see the header):
  // proposing is not their yes again until they vote or a new version lands.
  authorWithdrew?: boolean;
  openedAt: unknown;
  now: unknown;
  noTimers: boolean;
  memberFloor: Floor | null;
  mergeGate: (active: number, yes: number, no: number, openedAt: any, now: any) => Gate;
  applyNoTimerMerge: (gate: Gate, floor: Floor | null) => Gate;
  atLeastGate: (n: number, yes: number, no: number, openedAt: any, now: any) => Gate;
}

export interface RuleResult {
  group: string; kind: Measure; n: number | null; size: number; yes: number; no: number;
  authorYes: boolean; empty: boolean; known: boolean;
  // How many people this rule counts: the group, or its active people where
  // the rule's measure reads them. Said on the Votes card, never decided by.
  electorate: number;
  need: number | null; passed: boolean; gate: Gate | null;
  // The rule's minimum, and the yeses it asks for today (never more than the
  // group has); both null on a rule without one.
  min: number | null; minNeed: number | null;
}

/**
 * A majority rule's gate under its minimum: the bar is never below it, and
 * while the yeses are short of it nothing can merge, the quiet wait included,
 * so no clock is shown counting down to a merge that cannot happen. The
 * rejection side is the gate's own: a change the group is voting down still
 * closes on schedule.
 */
function underMinimum(gate: Gate, yes: number, minNeed: number): Gate {
  const required = Math.max(gate.required, minNeed);
  if (yes >= minNeed) return { ...gate, required };
  return {
    ...gate,
    required,
    thresholdMet: false,
    mergeable: false,
    windowMs: 0,
    windowEndsAt: null,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
  };
}

/**
 * Evaluate one rule. `ctx`: { facts, voters, counts, authorId, openedAt,
 * now, noTimers, memberFloor (null | { applies, met }), mergeGate,
 * applyNoTimerMerge }. Returns the rule's own status:
 *   { group, kind, n, size, yes, no, need, passed, empty, gate, min, minNeed }
 * where `gate` is the mergeGate object for a majority rule and `need` already
 * includes the minimum.
 */
export function evaluateRule(rule: Rule, ctx: EvalContext): RuleResult {
  const tally = groupTally(rule.group, ctx);
  let yes = tally.yes;
  // Proposing counts as a yes on the counted rules (see the header), unless
  // the author voted No, or already said yes, or is not a person, or a
  // coding agent put it up for them.
  const counted = rule.kind !== 'majority';
  let authorYes = false;
  if (counted && ctx.voters && !ctx.authorIsBot && !ctx.madeByAgent && !ctx.authorWithdrew
    && authorIn(rule.group, tally, ctx.authorId)
    && !ctx.voters.yes.has(ctx.authorId!) && !ctx.voters.no.has(ctx.authorId!)) {
    yes += 1;
    authorYes = true;
  }
  // The minimum counts the yeses its own rule counts: votes as cast on the
  // majority rule, proposing included on a percentage. Capped at the group's
  // size like atLeast, so a shrinking group never makes it impossible.
  const min = rule.kind !== 'atLeast' && rule.min != null ? rule.min : null;
  const minNeed = min != null ? Math.min(min, Math.max(tally.size, 1)) : null;
  const readsActive = rule.kind === 'percentOfActive' || (rule.kind === 'majority' && rule.group === 'members');
  const base = {
    group: rule.group, kind: rule.kind, n: rule.n, size: tally.size, yes, no: tally.no,
    authorYes, empty: tally.size === 0, known: tally.known, min, minNeed,
    electorate: readsActive ? Math.max(tally.active, 1) : tally.size,
  };
  if (tally.size === 0 && rule.group !== 'members') {
    return { ...base, need: null, passed: false, gate: null };
  }
  if (rule.kind === 'majority') {
    const electorate = rule.group === 'members' ? tally.active : Math.max(tally.size, 1);
    let gate = ctx.mergeGate(electorate, yes, tally.no, ctx.openedAt, ctx.now);
    if (ctx.noTimers) gate = ctx.applyNoTimerMerge(gate, ctx.memberFloor);
    if (minNeed != null) gate = underMinimum(gate, yes, minNeed);
    return { ...base, need: gate.required, passed: tally.known && !!gate.mergeable, gate };
  }
  const n = rule.n as number;
  let need;
  if (rule.kind === 'atLeast') need = Math.min(n, Math.max(tally.size, 1));
  else if (rule.kind === 'percentOfEveryone') need = Math.max(1, Math.ceil((n / 100) * tally.size));
  else need = Math.max(1, Math.ceil((n / 100) * Math.max(tally.active, 1)));
  if (minNeed != null) need = Math.max(need, minNeed);
  return { ...base, need, passed: tally.known && yes >= need, gate: null };
}

/**
 * The gate for one proposal under a rules value, shaped exactly like
 * active-users.js mergeGate's return so every consumer reads one object:
 * the clocks and the takedown come from the rule that owns them (the first
 * majority rule, else the first rule, under an at-least gate), and
 * `mergeable` is whether ANY rule passes. A proposal some rule passes is
 * never auto-rejected out from under it.
 *
 * `opts`:
 *   value          { rules } (the app's, or WHO_DECIDES for a change to who decides)
 *   facts, voters, counts, authorId, openedAt, now
 *   noTimers       the explicit-approval modifier: no quiet wait, no window
 *   memberFloor    the floor for the majority rules of a flagged proposal
 *   mergeGate, applyNoTimerMerge, atLeastGate   governance.js's own
 */
export function evaluateRules(opts: EvalContext & { value: { rules: readonly Rule[] } }) {
  const rules = opts.value.rules;
  const results = rules.map((r) => evaluateRule(r, opts));
  const owner = results.find((r) => r.kind === 'majority') || results[0];
  let gate: Gate;
  if (owner.gate) {
    gate = owner.gate;
  } else {
    gate = opts.atLeastGate(owner.need || 1, owner.yes, owner.no, opts.openedAt, opts.now);
    if (owner.need == null) gate = { ...gate, thresholdMet: false, mergeable: false };
  }
  // The rule that let it in: the owner's own when it passed, else the first
  // that did. When the group's vote and the creator's yes both pass (You or
  // the group: the creator's yes was the group's second), the group's is the
  // one the vote was shown against ("0 of 2", "1/2"), and the merge
  // snapshots its threshold; reporting the creator's rule first recorded
  // votes_required = 1 under two yes votes ("2 of 1", audit 2 Nov 2026).
  const passedBy = (owner.passed ? owner : null) || results.find((r) => r.passed) || null;
  const mergeable = !!passedBy;
  // Let in by another rule than the one that owns the clocks (the creator's
  // yes on You or the group): the owner's wait and threshold no longer apply,
  // so every surface that reads them sees a proposal that is through.
  const byOther = !!passedBy && passedBy !== owner;
  return {
    gate: {
      ...gate,
      required: owner.need != null ? owner.need : gate.required,
      thresholdMet: owner.passed || (!!gate.thresholdMet && owner.known),
      mergeable,
      ...(byOther ? {
        // Said in the terms of the rule that let it in ("1 of 1": the
        // creator's yes), which is the count `shown` reports beside it.
        required: passedBy!.need as number,
        thresholdMet: true,
        windowMs: 0,
        windowEndsAt: null,
        windowElapsed: true,
        lazyArmed: false,
        lazyWindowMs: null,
      } : {}),
      // Any rule passing keeps it alive (atLeastGate's keep-alive, for every rule).
      ...(mergeable ? { rejectionArmed: false, rejectionWindowMs: null, rejectionEndsAt: null, rejectable: false } : {}),
    } as Gate,
    owner,
    // The rule a surface counts for: the one that let it in, else the owner.
    shown: passedBy || owner,
    results,
    passedBy,
    partial: results.some((r) => !r.known),
  };
}
