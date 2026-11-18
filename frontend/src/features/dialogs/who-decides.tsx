/**
 * #4666: WHO CAN SEE & CHANGE IT (#who-decides-modal).
 *
 * One sheet for the two things that decide a project: who can see it, and how
 * its changes are approved. It replaces the approval controls of Members &
 * approvals, App settings' Access and the Settings & rules sheet's "Make it
 * public" / "Make it private", and whatever is changed here goes up as ONE
 * proposal (POST /api/apps/:slug/who-decides-pr):
 *
 *   Who can see it            Private community or Public community.
 *                             Everyone who can see it can suggest changes.
 *   How changes are approved  four presets (features/who-decides/model.ts),
 *                             or Make your own: groups and rules, any one
 *                             passing is enough, starting from the one
 *                             picked.
 *   How it plays out          what the pick means: for a change anyone
 *                             makes, or (You or the group) for you and
 *                             for anyone else.
 *   People                    who is in it and its admins, a door to the
 *                             Members dialog, where they are managed.
 *
 * A change to who decides goes live on the creator's yes or the group's real
 * yes votes, never on a quiet wait (src/services/governance-rules.js), and
 * the sheet says so wherever it asks for one.
 *
 * Ships hidden and EMPTY but for its root and card, like #topics-modal:
 * everything is drawn from the community record once it is open, so the
 * prerender and the first client render agree. Opened from the Workshop's
 * rule line (Rules), the Settings & rules sheet, App settings and Members, by
 * name: `window.UsernodeReact.dialogs.whoDecides.open({ slug, screen })`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import {
  AdjustmentsIcon, ChevronLeftIcon, GlobeIcon, LockIcon, PlusIcon, ShieldCheckIcon, UserGroupIcon, XIcon,
} from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';
import { agoStamp } from '../../lib/timestamp';
import { radioGroupKeys } from '../../lib/radio-group';
import { audienceLine, reloadCommunity, useCommunity } from '../dev-board/workshop/community-card';
import {
  appGroupFor, creatorGroupLine, currentValue, groupKey, groupLabel, groupNameProblem, groupPeopleKind, groupSize, matchPreset, MAX_AT_LEAST,
  MAX_GROUPS, MAX_RULES, MIN_MINIMUM, minOf, presetName, presetOf, presetValue, ruleGroupChoices, rulePhrase,
  ruleSignature, ruleToday, sameValue, undeclaredAppGroups, valueProblem, type AppGroup, type Group, type Kind,
  type PresetKey, type Rule, type RulesValue,
} from '../who-decides/model';
import { Face, PlaysOut, PresetTiles, Picked, type Viewer } from '../who-decides/parts';
import { proposeWhoDecides } from '../who-decides/propose';
import { useDialog } from './use-dialog';

type Screen = 'main' | 'own' | 'group' | 'rule';
type Visibility = 'private' | 'public';
// The two rows of "Who can see it", in the order they are drawn.
const VISIBILITIES: readonly Visibility[] = ['private', 'public'];

/** What the approval section has picked: a preset, or rules of the project's own. */
type Choice = { kind: 'preset'; key: PresetKey } | { kind: 'own'; value: RulesValue };

interface GroupDraft { index: number | null; name: string; people: string[]; keptByApp: boolean; size?: number; reportedAt?: string | null }
interface RuleDraft { index: number | null; group: string; kind: Kind; n: number; min: number | null }

/** Where a rule's minimum starts when it is switched on. */
const DEFAULT_MIN = 10;

const KINDS: readonly Kind[] = ['atLeast', 'percentOfActive', 'percentOfEveryone', 'majority'];
const KIND_IDS: Record<Kind, { label: string; sub: string }> = {
  atLeast: { label: 'dialogs:whoDecides.rule.kind.atLeast', sub: 'dialogs:whoDecides.rule.kind.atLeastSub' },
  percentOfActive: { label: 'dialogs:whoDecides.rule.kind.percentOfActive', sub: 'dialogs:whoDecides.rule.kind.percentOfActiveSub' },
  percentOfEveryone: { label: 'dialogs:whoDecides.rule.kind.percentOfEveryone', sub: 'dialogs:whoDecides.rule.kind.percentOfEveryoneSub' },
  majority: { label: 'dialogs:whoDecides.rule.kind.majority', sub: 'dialogs:whoDecides.rule.kind.majoritySub' },
};

const ROUND_BTN = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
const NOTE = 'px-1 text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400';
const ACCENT_TEXT = 'text-violet-600 dark:text-violet-400';

function choiceValue(choice: Choice | null): RulesValue | null {
  if (!choice) return null;
  return choice.kind === 'preset' ? presetValue(choice.key) : choice.value;
}

function Header({ title, sub, onBack, onClose }: { title: string; sub: string; onBack?: () => void; onClose: () => void }) {
  const t = useMessages('dialogs');
  return (
    <div className="mb-1 flex items-center gap-3">
      {onBack ? (
        <button type="button" onClick={onBack} aria-label={t('dialogs:whoDecides.back')} className={ROUND_BTN} data-who-back="">
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-bold leading-tight">{title}</h2>
        {sub ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{sub}</p> : null}
      </div>
      <button type="button" onClick={onClose} aria-label={t('dialogs:whoDecides.close')} className={ROUND_BTN} data-who-close="">
        <XIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function WhoDecidesDialog() {
  const t = useMessages('dialogs');
  const [slug, setSlug] = useState('');
  const [screen, setScreen] = useState<Screen>('main');
  const [vis, setVis] = useState<Visibility | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [draft, setDraft] = useState<RulesValue | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<{ sessionId: number | null; prNumber: number | null } | null>(null);
  const [admins, setAdmins] = useState<string[] | null>(null);
  const [everyone, setEveryone] = useState<string[] | null>(null);
  const pending = useRef(false);

  const dialog = useDialog<{ slug?: string; screen?: Screen }>('whoDecides', {
    phoneSheet: true,
    onOpen: (payload) => {
      const target = payload?.slug
        || (window.AppView?.appData?.slug as string | undefined)
        || ((window as unknown as { App?: { currentApp?: string | null } }).App?.currentApp ?? '')
        || '';
      setSlug(target);
      setScreen(payload?.screen === 'own' ? 'own' : 'main');
      setVis(null);
      setChoice(null);
      setDraft(null);
      setGroupDraft(null);
      setRuleDraft(null);
      setError('');
      setOpened(null);
      setAdmins(null);
      setEveryone(null);
      if (target) void reloadCommunity(target);
    },
    onClose: () => {
      setScreen('main');
      setError('');
    },
    canClose: () => !pending.current,
  });

  const community = useCommunity(slug);
  const approval = community?.approval || null;
  // #6811: the groups the app keeps. null from an older server, which sends
  // none: the sheet is then exactly what it was.
  const appGroups = approval && Array.isArray(approval.appGroups) ? approval.appGroups : null;
  const current = useMemo(() => currentValue(approval), [approval]);
  const nowPreset = presetOf(current);
  const creator = approval?.creator?.username || null;
  const creatorGone = approval?.creator_gone === true;
  const viewer: Viewer = { isCreator: !!community?.is_creator, creator };
  const visibility = community?.visibility || null;
  const currentVis: Visibility = visibility?.view === 'public' ? 'public' : 'private';
  const buildLimited = visibility?.view === 'public' && visibility?.build === 'private';
  const pickedVis: Visibility = vis || currentVis;
  // Public but building by invitation is neither row until one is picked.
  const seeChecked: Visibility | null = pickedVis === 'public' && buildLimited && !vis ? null : pickedVis;
  // One tab stop, and the arrow keys move the pick (#6510).
  const seeKeys = radioGroupKeys(VISIBILITIES, seeChecked, setVis);
  const name = community?.name || slug;
  const memberCount = Number(community?.member_count) || 0;

  // The project's admins, for the People row and an admins rule's count.
  useEffect(() => {
    if (!dialog.isOpen || !slug || admins !== null) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/admins`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live) return;
        const list = data && Array.isArray(data.admins) ? data.admins.map((a: { username?: string }) => String(a.username || '')).filter(Boolean) : [];
        setAdmins(list);
      })
      .catch(() => { if (live) setAdmins([]); });
    return () => { live = false; };
  }, [dialog.isOpen, slug, admins]);

  // Everyone in it, for choosing a group's people.
  useEffect(() => {
    if (screen !== 'group' || !slug || everyone !== null) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/community?members=all`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live) return;
        const list = data && Array.isArray(data.members) ? data.members.map((m: { username?: string }) => String(m.username || '')).filter(Boolean) : [];
        setEveryone(list);
      })
      .catch(() => { if (live) setEveryone([]); });
    return () => { live = false; };
  }, [screen, slug, everyone]);

  const close = () => dialog.close();
  const pickedValue = choiceValue(choice);
  const ruleChanged = !!pickedValue && !sameValue(pickedValue, current);
  const visChanged = !!vis && (vis !== currentVis || (vis === 'public' && buildLimited));
  const changes: Array<{ label: string; from: string; to: string }> = [];
  const describeValue = (value: RulesValue | null): string => {
    const key = presetOf(value);
    if (key) return presetName(key, viewer);
    if (value) return t('dialogs:whoDecides.own.name');
    return t('dialogs:whoDecides.legacyName');
  };
  const visName = (v: Visibility, limited = false) => (limited
    ? t('dialogs:whoDecides.see.limitedName')
    : t(v === 'public' ? 'dialogs:whoDecides.see.public' : 'dialogs:whoDecides.see.private'));
  if (visChanged) {
    changes.push({ label: t('dialogs:whoDecides.change.see'), from: visName(currentVis, buildLimited), to: visName(pickedVis) });
  }
  if (ruleChanged) {
    changes.push({ label: t('dialogs:whoDecides.change.rule'), from: describeValue(current), to: describeValue(pickedValue) });
  }
  const pickedPreset = choice ? (choice.kind === 'preset' ? choice.key : null) : nowPreset;
  const pickedOwn = choice ? choice.kind === 'own' : (!!current && !nowPreset);
  const warnPublic = pickedVis === 'public' && (pickedPreset === 'open_floor' || pickedPreset === 'two_yeses');
  const waiting = community?.who_decides_change || null;
  const ctx = {
    groups: (draft || pickedValue || current)?.groups || [],
    creator,
    memberCount,
    adminCount: admins ? admins.length : null,
  };

  async function propose() {
    if (pending.current || !slug || (!visChanged && !ruleChanged)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await proposeWhoDecides(slug, {
        visibility: visChanged ? pickedVis : null,
        governance: ruleChanged ? pickedValue : null,
      });
      if (result.state === 'notVerified') {
        setError(t('dialogs:whoDecides.notVerified'));
        return;
      }
      setOpened({ sessionId: result.sessionId, prNumber: result.prNumber });
      void reloadCommunity(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dialogs:whoDecides.error'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  // ── Make your own ────────────────────────────────────────────────────

  function startOwn() {
    // Starts from what is picked: a preset's rules, the project's own, or,
    // for an old setting no preset is, Group vote's.
    const from = pickedValue || current || presetValue('group_vote');
    setDraft({ preset: null, groups: from.groups.map((g) => ({ ...g, people: [...g.people] })), rules: from.rules.map((r) => ({ ...r })) });
    setScreen('own');
  }

  function useDraft() {
    if (!draft || valueProblem(draft)) return;
    const asPreset = !draft.groups.length ? matchPreset(draft.rules) : null;
    setChoice(asPreset ? { kind: 'preset', key: asPreset } : { kind: 'own', value: draft });
    setScreen('main');
  }

  // The line under a group's name on the Groups list: the people picked here,
  // or, for a group the app keeps, how many it last reported (#6669).
  function groupLine(g: Group): string {
    const kind = groupPeopleKind(g);
    if (kind === 'keptByApp') return t('dialogs:whoDecides.group.keptByAppSub', { count: g.size ?? 0 });
    if (kind === 'people') return g.people.join(', ');
    return t('dialogs:whoDecides.group.nobody');
  }

  function editGroup(index: number | null) {
    const g = index != null && draft ? draft.groups[index] : null;
    setGroupDraft({
      index, name: g ? g.name : '', people: g ? [...g.people] : [],
      keptByApp: !!g?.keptByApp, size: g?.size, reportedAt: g?.reportedAt ?? null,
    });
    setScreen('group');
  }

  function saveGroup() {
    if (!draft || !groupDraft) return;
    const problem = groupNameProblem(groupDraft.name, draft.groups, groupDraft.index != null ? groupKey(draft.groups[groupDraft.index].name) : null);
    if (problem) return;
    const clean = groupDraft.name.replace(/\s+/g, ' ').trim();
    // #6811: a kept group takes its size and last-sent time from the app's
    // own row, matched by name, so a hand-typed name shows the real count and
    // a renamed one re-matches. With no appGroups (an older server) the group
    // keeps what it had.
    const match = groupDraft.keptByApp ? appGroupFor(appGroups, clean) : null;
    const nextGroup: Group = groupDraft.keptByApp
      ? {
        name: clean, people: [], keptByApp: true,
        size: match ? match.size : (appGroups ? 0 : groupDraft.size ?? 0),
        reportedAt: match ? match.reportedAt : (appGroups ? null : groupDraft.reportedAt ?? null),
      }
      : { name: clean, people: groupDraft.people };
    const groups = [...draft.groups];
    let rules = draft.rules;
    if (groupDraft.index != null) {
      const before = groupKey(groups[groupDraft.index].name);
      groups[groupDraft.index] = nextGroup;
      const after = groupKey(nextGroup.name);
      if (before !== after) rules = rules.map((r) => (r.group === before ? { ...r, group: after } : r));
    } else {
      groups.push(nextGroup);
    }
    setDraft({ ...draft, groups, rules });
    setScreen('own');
  }

  // #6811: one tap adds a group the app keeps to the draft, with the app's
  // real size, so a rule can name it at once. Proposing still writes the same
  // `{ name, keptByApp: true }` the switch does, and nothing goes live without
  // the usual vote.
  function addAppGroup(g: AppGroup) {
    if (!draft || draft.groups.length >= MAX_GROUPS) return;
    setDraft({
      ...draft,
      groups: [...draft.groups, { name: g.name, people: [], keptByApp: true, size: g.size, reportedAt: g.reportedAt }],
    });
  }

  function deleteGroup() {
    if (!draft || !groupDraft || groupDraft.index == null) return;
    const key = groupKey(draft.groups[groupDraft.index].name);
    if (draft.rules.some((r) => r.group === key)) return;
    setDraft({ ...draft, groups: draft.groups.filter((_, i) => i !== groupDraft.index) });
    setScreen('own');
  }

  function editRule(index: number | null) {
    const r = index != null && draft ? draft.rules[index] : null;
    setRuleDraft(r
      ? { index, group: r.group, kind: r.kind, n: r.n ?? (r.kind === 'atLeast' ? 1 : 50), min: minOf(r) }
      : { index: null, group: 'members', kind: 'atLeast', n: 2, min: null });
    setScreen('rule');
  }

  function ruleOf(d: RuleDraft): Rule {
    if (d.group === 'creator') return { group: 'creator', kind: 'atLeast', n: 1 };
    const rule: Rule = { group: d.group, kind: d.kind, n: d.kind === 'majority' ? null : d.n };
    // A minimum goes with a majority or a share; "a number of people" is one already.
    return d.kind !== 'atLeast' && d.min != null ? { ...rule, min: d.min } : rule;
  }

  function saveRule() {
    if (!draft || !ruleDraft) return;
    const rule = ruleOf(ruleDraft);
    const rules = [...draft.rules];
    if (ruleDraft.index != null) rules[ruleDraft.index] = rule; else rules.push(rule);
    const next = { ...draft, rules };
    if (valueProblem(next)) return;
    setDraft(next);
    setScreen('own');
  }

  function removeRule(index: number) {
    if (!draft || draft.rules.length <= 1) return;
    setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) });
    if (screen === 'rule') setScreen('own');
  }

  // ── Screens ──────────────────────────────────────────────────────────

  function Main() {
    const sub = community ? t('dialogs:whoDecides.sub', { name, audience: audienceLine(community) }) : '';
    return (
      <>
        <Header title={t('dialogs:whoDecides.title')} sub={sub} onClose={close} />

        {community?.can_manage !== false ? (
          <>
            <SectionHeader className="px-1 pb-2 pt-4" id="who-see-label">{t('dialogs:whoDecides.see.title')}</SectionHeader>
            <GroupedList className="mx-0" role="radiogroup" aria-labelledby="who-see-label" data-who-see="" onKeyDown={seeKeys.onKeyDown}>
              {VISIBILITIES.map((v) => (
                <ListRow
                  key={v}
                  as="button"
                  role="radio"
                  aria-checked={seeChecked === v}
                  tabIndex={seeKeys.tabIndex(v)}
                  data-who-see-option={v}
                  onClick={() => setVis(v)}
                  leading={<IconTile size="xs">{v === 'private' ? <LockIcon aria-hidden="true" /> : <GlobeIcon aria-hidden="true" />}</IconTile>}
                  title={visName(v)}
                  subtitle={t(v === 'private' ? 'dialogs:whoDecides.see.privateSub' : 'dialogs:whoDecides.see.publicSub')}
                  subtitleClassName="whitespace-normal"
                  chevron={false}
                  trailing={<Picked on={seeChecked === v} />}
                />
              ))}
            </GroupedList>
            <p className={`mt-2 ${NOTE}`}>
              {buildLimited && !vis ? t('dialogs:whoDecides.see.limitedNote') : t('dialogs:whoDecides.see.note')}
            </p>
          </>
        ) : null}

        <SectionHeader className="px-1 pb-2 pt-5" id="who-rule-label">{t('dialogs:whoDecides.rule.title')}</SectionHeader>
        {warnPublic ? (
          <p className="mb-2 px-1 text-[13px] leading-snug text-zinc-900 dark:text-zinc-100" data-who-public-warning="">
            {t('dialogs:whoDecides.publicWarning')}
          </p>
        ) : null}
        {!current ? (
          <p className={`mb-2 ${NOTE}`} data-who-legacy="">{t('dialogs:whoDecides.legacyNote')}</p>
        ) : null}
        <PresetTiles
          picked={pickedOwn ? null : pickedPreset}
          now={nowPreset}
          viewer={viewer}
          labelId="who-rule-label"
          onPick={(key) => setChoice({ kind: 'preset', key })}
        />
        <GroupedList className="mx-0 mt-2">
          <ListRow
            as="button"
            data-who-own=""
            onClick={() => (pickedOwn && choice?.kind === 'own' ? (setDraft(choice.value), setScreen('own')) : startOwn())}
            leading={<IconTile size="xs"><AdjustmentsIcon aria-hidden="true" /></IconTile>}
            title={t('dialogs:whoDecides.own.name')}
            subtitle={pickedOwn
              ? t('dialogs:whoDecides.own.picked', { count: (pickedValue || current)?.rules.length || 0 })
              : t('dialogs:whoDecides.own.sub')}
            subtitleClassName="whitespace-normal"
            trailing={pickedOwn ? <Picked on /> : undefined}
          />
        </GroupedList>

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.plays.title')}</SectionHeader>
        <PlaysOut preset={pickedOwn ? null : pickedPreset} viewer={viewer} />
        <p className={`mt-2 flex gap-1.5 ${NOTE}`}>
          <ShieldCheckIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{viewer.isCreator || !creator
            ? t('dialogs:whoDecides.alwaysYou')
            : t('dialogs:whoDecides.alwaysCreator', { creator })}</span>
        </p>

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.people.title')}</SectionHeader>
        <GroupedList className="mx-0" data-who-people="">
          <ListRow
            as="button"
            data-who-members=""
            onClick={() => { close(); window.AppView?.openMembersModal?.(); }}
            leading={(
              <span className="flex -space-x-1.5 rtl:space-x-reverse">
                {(community?.members || []).slice(0, 3).map((m) => <Face key={m.username} name={m.username} size={26} />)}
              </span>
            )}
            title={t('dialogs:whoDecides.people.members')}
            subtitle={t('dialogs:whoDecides.people.membersSub', { count: memberCount })}
            subtitleClassName="whitespace-normal"
          />
          <ListRow
            as="button"
            data-who-admins=""
            onClick={() => { close(); window.AppView?.openMembersModal?.(); }}
            leading={<IconTile size="xs"><UserGroupIcon aria-hidden="true" /></IconTile>}
            title={t('dialogs:whoDecides.people.admins')}
            subtitle={admins && admins.length
              ? admins.slice(0, 3).join(', ')
              : t('dialogs:whoDecides.people.adminsNone')}
            subtitleClassName="whitespace-normal"
          />
        </GroupedList>

        <div className="mt-5 rounded-[20px] bg-white p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900" data-who-summary="">
          {opened ? (
            <>
              <p className="text-[15px] font-[650]">{t('dialogs:whoDecides.opened')}</p>
              <p className="mt-1 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">{t('dialogs:whoDecides.openedSub')}</p>
              {opened.sessionId ? (
                <Button type="button" layout="full" variant="pillNeutral" size="pillLg" ink="neutral" className="mt-3 flex items-center justify-center"
                  onClick={() => { dialog.closeForNavigation(); window.location.hash = changeHref(slug, opened.sessionId).replace(/^#/, ''); }}>
                  {t('dialogs:whoDecides.open')}
                </Button>
              ) : null}
            </>
          ) : changes.length ? (
            <>
              {/* #4960: another access change may already be up for a vote;
                  competing ones are allowed, so Propose stays enabled and
                  the heading warns here, where the person is looking. */}
              <p className="text-[15px] font-[650]">
                {waiting ? t('dialogs:whoDecides.waitingTitle') : t('dialogs:whoDecides.count', { count: changes.length })}
              </p>
              {changes.map((c) => (
                <p key={c.label} className="mt-1 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
                  {t('dialogs:whoDecides.changeLine', { what: c.label, from: c.from, to: c.to })}
                </p>
              ))}
              {waiting ? (
                <p className="mt-1 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300" data-who-waiting-warning="">
                  {`${t('dialogs:whoDecides.waitingSub')} `}
                  <a className={`font-semibold ${ACCENT_TEXT}`} href={changeHref(slug, waiting.session_id)} onClick={() => dialog.closeForNavigation()}>
                    {t('dialogs:whoDecides.open')}
                  </a>
                </p>
              ) : null}
              <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-3 flex items-center justify-center"
                data-who-propose="" disabledStyle="block" disabled={busy} onClick={() => void propose()}>
                {busy ? t('dialogs:whoDecides.proposing') : t('dialogs:whoDecides.propose', { count: changes.length })}
              </Button>
              <p className="mt-2 text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                {viewer.isCreator || !creator ? t('dialogs:whoDecides.proposeNoteYou') : t('dialogs:whoDecides.proposeNoteCreator', { creator })}
              </p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-[650]">{t('dialogs:whoDecides.nothing')}</p>
              <p className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.nothingSub')}</p>
            </>
          )}
          {error ? <p className="mt-2 text-[13px] text-red-700 dark:text-red-400" role="alert" data-who-error="">{error}</p> : null}
        </div>
      </>
    );
  }

  function Own() {
    if (!draft) return null;
    const same = !draft.groups.length ? matchPreset(draft.rules) : null;
    const from = choice?.kind === 'preset' ? choice.key : nowPreset;
    const problem = valueProblem(draft);
    const ownCtx = { ...ctx, groups: draft.groups };
    return (
      <>
        <Header
          title={t('dialogs:whoDecides.own.name')}
          sub={from ? t('dialogs:whoDecides.own.startedFrom', { name, preset: presetName(from, viewer) }) : name}
          onBack={() => setScreen('main')}
          onClose={close}
        />
        {same ? (
          <p className="mt-3 px-1 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300" data-who-same="">
            {t('dialogs:whoDecides.own.same', { preset: presetName(same, viewer) })}
          </p>
        ) : null}

        <SectionHeader className="px-1 pb-2 pt-4">{t('dialogs:whoDecides.own.rules')}</SectionHeader>
        <GroupedList className="mx-0" data-who-rules="">
          {draft.rules.map((r, i) => (
            <div key={ruleSignature(r)}>
              {i > 0 ? (
                <div className="flex items-center gap-2 px-4" aria-hidden="true">
                  <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                  <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.own.or')}</span>
                  <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                </div>
              ) : null}
              <div className="flex items-center pe-2">
                <ListRow
                  as="button"
                  inset="none"
                  className="flex-1"
                  data-who-rule={i}
                  onClick={() => editRule(i)}
                  title={rulePhrase(r, ownCtx)}
                  subtitle={ruleToday(r, ownCtx)}
                  titleClassName="whitespace-normal"
                  subtitleClassName="whitespace-normal"
                  chevron={false}
                />
                {draft.rules.length > 1 ? (
                  <button
                    type="button"
                    aria-label={t('dialogs:whoDecides.rule.remove')}
                    onClick={() => removeRule(i)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 dark:text-zinc-400"
                  >
                    <XIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {draft.rules.length < MAX_RULES ? (
            <ListRow
              as="button"
              data-who-add-rule=""
              onClick={() => editRule(null)}
              leading={<IconTile size="xs"><PlusIcon aria-hidden="true" /></IconTile>}
              title={<span className={ACCENT_TEXT}>{t('dialogs:whoDecides.own.addRule')}</span>}
              subtitle={t('dialogs:whoDecides.own.ruleCount', { count: draft.rules.length, max: MAX_RULES })}
              chevron={false}
            />
          ) : null}
        </GroupedList>

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.own.groups')}</SectionHeader>
        <GroupedList className="mx-0" data-who-groups="">
          <ListRow title={t('dialogs:whoDecides.group.creator')} subtitle={creatorGroupLine(creator, creatorGone)} chevron={false}
            subtitleClassName="whitespace-normal"
            trailing={<span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.builtIn')}</span>} />
          <ListRow title={t('dialogs:whoDecides.group.members')} subtitle={t('dialogs:whoDecides.group.membersSub', { count: memberCount })} chevron={false}
            subtitleClassName="whitespace-normal"
            trailing={<span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.builtIn')}</span>} />
          <ListRow title={t('dialogs:whoDecides.group.admins')} subtitle={admins && admins.length ? admins.join(', ') : t('dialogs:whoDecides.group.nobody')} chevron={false}
            trailing={<span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.builtIn')}</span>} />
          {draft.groups.map((g, i) => (
            <ListRow key={groupKey(g.name)} as="button" data-who-group={i} onClick={() => editGroup(i)} title={g.name}
              subtitle={groupLine(g)}
              subtitleClassName="whitespace-normal"
              trailing={g.keptByApp ? <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.keptByApp')}</span> : undefined} />
          ))}
          {draft.groups.length < MAX_GROUPS ? undeclaredAppGroups(appGroups, draft.groups).map((g) => {
            const sent = g.reportedAt ? agoStamp(g.reportedAt) : null;
            return (
              <ListRow key={g.key} as="button" data-who-app-group={g.key} onClick={() => addAppGroup(g)} title={g.name}
                subtitle={sent
                  ? <span title={sent.title}>{t('dialogs:whoDecides.group.appGroupSub', { count: g.size, when: sent.text })}</span>
                  : t('dialogs:whoDecides.group.appGroupNotSent')}
                subtitleClassName="whitespace-normal"
                trailing={<span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.keptByApp')}</span>} />
            );
          }) : null}
          {draft.groups.length < MAX_GROUPS ? (
            <ListRow as="button" data-who-add-group="" onClick={() => editGroup(null)}
              leading={<IconTile size="xs"><PlusIcon aria-hidden="true" /></IconTile>}
              title={<span className={ACCENT_TEXT}>{t('dialogs:whoDecides.own.addGroup')}</span>} chevron={false} />
          ) : null}
        </GroupedList>

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.own.alwaysOn')}</SectionHeader>
        <GroupedList className="mx-0">
          <ListRow leading={<IconTile size="xs"><LockIcon aria-hidden="true" /></IconTile>} title={t('dialogs:whoDecides.own.alwaysTitle')} chevron={false}
            subtitle={creator ? t('dialogs:whoDecides.own.alwaysSub', { creator }) : t('dialogs:whoDecides.own.alwaysSubNobody')}
            subtitleClassName="whitespace-normal" />
        </GroupedList>

        {problem ? <p className="mt-3 px-1 text-[13px] text-red-700 dark:text-red-400" role="alert">{problem}</p> : null}
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-5 flex items-center justify-center"
          data-who-use-rules="" disabledStyle="block" disabled={!!problem} onClick={useDraft}>
          {t('dialogs:whoDecides.own.use')}
        </Button>
        <p className="mt-2 text-center text-[12.5px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.own.useNote')}</p>
      </>
    );
  }

  function GroupScreen() {
    if (!draft || !groupDraft) return null;
    const editingKey = groupDraft.index != null ? groupKey(draft.groups[groupDraft.index].name) : null;
    const problem = groupDraft.name.trim() ? groupNameProblem(groupDraft.name, draft.groups, editingKey) : null;
    // #6811: a kept group's count and last-sent time come from the app's own
    // list, matched by name, so a typed name shows the real size and a typo is
    // caught before the vote. With no appGroups (an older server) the group
    // shows what it had, as today.
    const match = groupDraft.keptByApp ? appGroupFor(appGroups, groupDraft.name) : null;
    const known = match || (appGroups ? null : { size: groupDraft.size ?? 0, reportedAt: groupDraft.reportedAt ?? null });
    const usedBy = editingKey ? draft.rules.filter((r) => r.group === editingKey) : [];
    const pool = (everyone || (community?.members || []).map((m) => m.username)).filter((u) => !groupDraft.people.includes(u));
    const setPeople = (people: string[]) => setGroupDraft({ ...groupDraft, people });
    return (
      <>
        <Header
          title={groupDraft.index != null ? t('dialogs:whoDecides.group.title') : t('dialogs:whoDecides.group.newTitle')}
          sub={t('dialogs:whoDecides.group.sub', { name })}
          onBack={() => setScreen('own')}
          onClose={close}
        />
        <div className="mt-3">
          <label htmlFor="who-group-name" className="mb-1 block text-sm font-medium text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.name')}</label>
          <Input
            id="who-group-name"
            type="text"
            box="dialog"
            hint="muted"
            ring="seamless"
            maxLength={32}
            defaultValue={groupDraft.name}
            onInput={(e) => setGroupDraft({ ...groupDraft, name: e.currentTarget.value })}
          />
          {problem ? <p className="mt-1 px-1 text-[13px] text-red-700 dark:text-red-400" role="alert">{problem}</p> : null}
        </div>
        <GroupedList className="mx-0 mt-3">
          <label className="flex w-full cursor-pointer items-start gap-4 px-4 py-3.5">
            <span className="ui-lrow-tx min-w-0 flex-1">
              <span className="ui-lrow-t block text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
                {t('dialogs:whoDecides.group.keptSwitch')}
              </span>
              <span className="ui-lrow-s mt-0.5 block text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
                {t('dialogs:whoDecides.group.keptSwitchSub')}
              </span>
            </span>
            <Switch
              data-who-kept-switch=""
              checked={groupDraft.keptByApp}
              onChange={(e) => setGroupDraft({
                ...groupDraft,
                keptByApp: e.currentTarget.checked,
                people: e.currentTarget.checked ? [] : groupDraft.people,
              })}
            />
          </label>
        </GroupedList>
        {groupDraft.keptByApp ? (
          <>
            <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.group.people', { count: known ? known.size : 0 })}</SectionHeader>
            {appGroups && groupDraft.name.trim() && !match ? (
              <p className="mt-2 px-1 text-[13px] text-red-700 dark:text-red-400" data-who-kept-nomatch="" role="alert">
                {t('dialogs:whoDecides.group.appGroupNoMatch')}
              </p>
            ) : (
              <p className={`mt-2 ${NOTE}`} data-who-kept-line="">
                {known?.reportedAt
                  ? t('dialogs:whoDecides.group.keptReported', { when: new Date(known.reportedAt).toLocaleString() })
                  : t('dialogs:whoDecides.group.keptNever')}
              </p>
            )}
          </>
        ) : (
          <>
            <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.group.people', { count: groupDraft.people.length })}</SectionHeader>
            <GroupedList className="mx-0" data-who-group-people="">
              {groupDraft.people.map((p) => (
                <ListRow key={p} leading={<Face name={p} />} title={p} chevron={false}
                  trailing={(
                    <button type="button" aria-label={t('dialogs:whoDecides.group.removePerson', { name: p })} onClick={() => setPeople(groupDraft.people.filter((x) => x !== p))}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 dark:text-zinc-400">
                      <XIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )} />
              ))}
              {!groupDraft.people.length ? <ListRow title={t('dialogs:whoDecides.group.nobody')} chevron={false} /> : null}
              {pool.length ? (
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.add')}</span>
                  {pool.slice(0, 24).map((p) => (
                    <Button key={p} type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={() => setPeople([...groupDraft.people, p])} className="flex items-center gap-1.5">
                      <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />{p}
                    </Button>
                  ))}
                </div>
              ) : null}
            </GroupedList>
            <p className={`mt-2 ${NOTE}`}>{t('dialogs:whoDecides.group.note', { name })}</p>
          </>
        )}
        {usedBy.length ? (
          <>
            <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.group.usedBy', { count: usedBy.length })}</SectionHeader>
            <GroupedList className="mx-0">
              {usedBy.map((r) => (
                <ListRow key={ruleSignature(r)} title={rulePhrase(r, { groups: draft.groups, creator })}
                  subtitle={ruleToday(r, { ...ctx, groups: draft.groups.map((g) => (groupKey(g.name) === editingKey ? { ...g, people: groupDraft.people } : g)) })}
                  chevron={false} titleClassName="whitespace-normal" subtitleClassName="whitespace-normal" />
              ))}
            </GroupedList>
          </>
        ) : null}
        <p className={`mt-3 flex gap-1.5 ${NOTE}`}>
          <LockIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('dialogs:whoDecides.group.whoDecides')}</span>
        </p>
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-4 flex items-center justify-center"
          data-who-save-group="" disabledStyle="block" disabled={!groupDraft.name.trim() || !!problem} onClick={saveGroup}>
          {t('dialogs:whoDecides.group.save')}
        </Button>
        {groupDraft.index != null ? (
          usedBy.length ? (
            <p className="mt-2 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.group.cannotDelete')}</p>
          ) : (
            <Button type="button" layout="full" variant="unstyled" size="plain" ink="dangerTint" className="mt-2" onClick={deleteGroup}>
              {t('dialogs:whoDecides.group.delete')}
            </Button>
          )
        ) : null}
      </>
    );
  }

  function RuleScreen() {
    if (!draft || !ruleDraft) return null;
    const groupsHere = ruleGroupChoices(draft.groups, { creatorGone, current: ruleDraft.group });
    const rule = ruleOf(ruleDraft);
    const ruleCtx = { ...ctx, groups: draft.groups };
    const isPct = ruleDraft.kind === 'percentOfActive' || ruleDraft.kind === 'percentOfEveryone';
    const others = draft.rules.filter((_, i) => i !== ruleDraft.index);
    const duplicate = others.some((r) => ruleSignature(r) === ruleSignature(rule));
    const set = (patch: Partial<RuleDraft>) => setRuleDraft({ ...ruleDraft, ...patch });
    const pickKind = (k: Kind) => set({ kind: k, n: k === 'atLeast' ? Math.min(ruleDraft.n, MAX_AT_LEAST) : (k === 'majority' ? ruleDraft.n : 50) });
    // One tab stop, and the arrow keys move the pick (#6510).
    const kindKeys = radioGroupKeys(KINDS, ruleDraft.kind, pickKind);
    const size = groupSize(rule.group, ruleCtx);
    return (
      <>
        <Header
          title={ruleDraft.index != null ? t('dialogs:whoDecides.rule.editTitle') : t('dialogs:whoDecides.rule.newTitle')}
          sub={t('dialogs:whoDecides.group.sub', { name })}
          onBack={() => setScreen('own')}
          onClose={close}
        />
        <GroupedList className="mx-0 mt-3">
          <p className="px-4 py-4 text-[17px] font-semibold leading-7" data-who-rule-sentence="">
            {t('dialogs:whoDecides.rule.sentence', { rule: rulePhrase(rule, ruleCtx) })}
          </p>
        </GroupedList>

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.rule.whose')}</SectionHeader>
        <div className="flex flex-wrap gap-2" data-who-rule-groups="">
          {groupsHere.map((g) => (
            <Chip key={g} size="bar" selected={ruleDraft.group === g} onClick={() => set({ group: g })} className="px-4">
              {groupLabel(g, draft.groups)}
            </Chip>
          ))}
        </div>

        {rule.group !== 'creator' ? (
          <>
            <SectionHeader className="px-1 pb-2 pt-5" id="who-rule-kind-label">{t('dialogs:whoDecides.rule.howMany')}</SectionHeader>
            <GroupedList className="mx-0" role="radiogroup" aria-labelledby="who-rule-kind-label" onKeyDown={kindKeys.onKeyDown}>
              {KINDS.map((k) => (
                <ListRow key={k} as="button" role="radio" aria-checked={ruleDraft.kind === k} tabIndex={kindKeys.tabIndex(k)} data-who-rule-kind={k}
                  onClick={() => pickKind(k)}
                  title={t(KIND_IDS[k].label)} subtitle={t(KIND_IDS[k].sub)} subtitleClassName="whitespace-normal" chevron={false}
                  trailing={<Picked on={ruleDraft.kind === k} />} />
              ))}
              {ruleDraft.kind !== 'majority' ? (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[15px] font-[650]">{isPct ? t('dialogs:whoDecides.rule.percent') : t('dialogs:whoDecides.rule.people')}</span>
                  <span className="flex items-center gap-2">
                    <Button type="button" aria-label={t('dialogs:whoDecides.rule.fewer')} variant="pillNeutral" size="sm" ink="neutral" className="h-11 w-11 !px-0 text-xl"
                      onClick={() => set({ n: isPct ? Math.max(10, ruleDraft.n - 10) : Math.max(1, ruleDraft.n - 1) })}>−</Button>
                    <span className="min-w-[3.5rem] text-center text-[17px] font-bold tabular-nums" data-who-rule-n="">
                      {isPct ? t('dialogs:whoDecides.rule.percentValue', { percent: ruleDraft.n }) : ruleDraft.n}
                    </span>
                    <Button type="button" aria-label={t('dialogs:whoDecides.rule.more')} variant="pillNeutral" size="sm" ink="neutral" className="h-11 w-11 !px-0 text-xl"
                      onClick={() => set({ n: isPct ? Math.min(100, ruleDraft.n + 10) : Math.min(MAX_AT_LEAST, ruleDraft.n + 1) })}>+</Button>
                  </span>
                </div>
              ) : null}
            </GroupedList>
            {ruleDraft.kind !== 'atLeast' ? (
              <GroupedList className="mx-0 mt-3" data-who-rule-min="">
                <label htmlFor="who-rule-min" className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-[650]">{t('dialogs:whoDecides.rule.min.title')}</span>
                    <span className="block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{t('dialogs:whoDecides.rule.min.sub')}</span>
                  </span>
                  <Switch id="who-rule-min" checked={ruleDraft.min != null}
                    onChange={(event) => set({ min: event.target.checked ? DEFAULT_MIN : null })} />
                </label>
                {ruleDraft.min != null ? (
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-[15px] font-[650]">{t('dialogs:whoDecides.rule.min.label')}</span>
                    <span className="flex items-center gap-2">
                      <Button type="button" aria-label={t('dialogs:whoDecides.rule.fewer')} variant="pillNeutral" size="sm" ink="neutral" className="h-11 w-11 !px-0 text-xl"
                        onClick={() => set({ min: Math.max(MIN_MINIMUM, (ruleDraft.min ?? DEFAULT_MIN) - 1) })}>−</Button>
                      <span className="min-w-[3.5rem] text-center text-[17px] font-bold tabular-nums" data-who-rule-min-n="">{ruleDraft.min}</span>
                      <Button type="button" aria-label={t('dialogs:whoDecides.rule.more')} variant="pillNeutral" size="sm" ink="neutral" className="h-11 w-11 !px-0 text-xl"
                        onClick={() => set({ min: Math.min(MAX_AT_LEAST, (ruleDraft.min ?? DEFAULT_MIN) + 1) })}>+</Button>
                    </span>
                  </div>
                ) : null}
              </GroupedList>
            ) : null}
          </>
        ) : null}

        <SectionHeader className="px-1 pb-2 pt-5">{t('dialogs:whoDecides.rule.today.title')}</SectionHeader>
        <GroupedList className="mx-0">
          <p className="px-4 py-3.5 text-[15px] leading-snug" data-who-rule-today="">
            {size === 0
              ? t('dialogs:whoDecides.rule.today.empty', { group: groupLabel(rule.group, draft.groups) })
              : ruleToday(rule, ruleCtx)}
          </p>
        </GroupedList>
        <p className={`mt-2 ${NOTE}`}>{t('dialogs:whoDecides.rule.yesesOnly')}</p>
        {duplicate ? <p className="mt-2 px-1 text-[13px] text-red-700 dark:text-red-400" role="alert">{t('dialogs:whoDecides.own.problem.duplicate')}</p> : null}
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-5 flex items-center justify-center"
          data-who-save-rule="" disabledStyle="block" disabled={duplicate} onClick={saveRule}>
          {t('dialogs:whoDecides.rule.save')}
        </Button>
        {ruleDraft.index != null && draft.rules.length > 1 ? (
          <Button type="button" layout="full" variant="unstyled" size="plain" ink="dangerTint" className="mt-2"
            onClick={() => removeRule(ruleDraft.index as number)}>
            {t('dialogs:whoDecides.rule.remove')}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <DialogRoot id="who-decides-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="sm">
        {dialog.isOpen ? (
          <div data-who-screen={screen}>
            {screen === 'main' ? Main() : null}
            {screen === 'own' ? Own() : null}
            {screen === 'group' ? GroupScreen() : null}
            {screen === 'rule' ? RuleScreen() : null}
          </div>
        ) : null}
      </DialogCard>
    </DialogRoot>
  );
}
