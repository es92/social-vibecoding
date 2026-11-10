/**
 * YOUR FIRST CHANGE HERE (10 Nov 2026): a project's Workshop, for a member
 * who has made nothing on it yet. Where Your work would say "Nothing of yours
 * here right now." (./your-work.tsx), this card asks who should build what
 * they have in mind:
 *
 *   Make your first change here                                   ✕
 *   Pick who does the building. Whatever it makes goes to the group…
 *   [H]  Homeroom bot    Say what you want. It builds it here.     ›
 *   [>_] Claude Code     On your own Claude plan             Set up
 *   [◯]  ChatGPT         On your own ChatGPT plan            Set up
 *
 * Each row is a link to a new thread with Homeroom bot's "+" pressed for
 * them, already set to this project and to that builder (../../ai/door.ts
 * botNewAddress; ../../messages/new-thread.tsx and thread-builder.tsx). There
 * Homeroom bot takes the message, and Claude Code or ChatGPT are handed it,
 * after the steps to connect Homeroom when that product has no connection.
 *
 * ── Who sees it ────────────────────────────────────────────────────────
 *
 * Somebody with nothing of theirs on the project, now or before
 * (firstChangeFor): the Homeroom bot tab's own lists have nothing here for
 * them (../../ai/desk.ts) and its History has nothing they made here (GET
 * /api/ai/history?project=<slug>; a vote is taking part, not making). When
 * either read is missing, or History has more pages than the one read, the
 * card stays away: Your work is the safe answer. Not for somebody who may
 * not start a change here, as the hub's start-here card is not
 * (improveStore.readOnly).
 *
 * It closes like the hub's cards (./hub-dismissed.ts): for good, on this
 * project, on this device. Your work comes back in its place.
 *
 * Nothing is read in the first render, which is the prerender's: Your work's
 * title alone, until the reads land.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { ListRow } from '@/components/ui/grouped-list';
import { ChatIcon, TerminalIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import type { DeskSummary } from '../../ai/desk';
import { BOT_NEW_BUILDERS, botNewAddress, type BotNewBuilder } from '../../ai/door';
import { improveStore } from '../../improve/improve-store.js';
import { listConnectors } from '../../messages/api';
import { BOT_AVATAR } from '../../messages/format';
import { BUILDER_NAME, BUILDER_PRODUCT, connectedBuilders, type OwnBuilder } from '../../messages/thread-builder';
import { HubCardClose } from './community-card';
import { useHubDismissed } from './hub-dismissed';

/** One read of a project's History for the viewer: its first page, and whether there is more. */
export interface MadeRead {
  rows: ReadonlyArray<{ kind?: string | null }>;
  next: string | null;
}

/**
 * Pure: whether this is somebody who has made nothing on the project. Both
 * reads are needed, and an unread one says no.
 */
export function firstChangeFor(desk: DeskSummary, made: MadeRead | null): boolean {
  if (!desk.ready || !made) return false;
  if (desk.needs + desk.progress + desk.waiting > 0) return false;
  // More History than this page: it cannot be called empty of their work.
  if (made.next) return false;
  return !made.rows.some((row) => row && row.kind !== 'vote');
}

const KEEP_MS = 20000;
const kept = new Map<string, { at: number; read: Promise<MadeRead | null> }>();

/** What the viewer made on `slug` before, as History lists it; kept a short while, like the desk's reads. */
export function readMade(slug: string, now = Date.now()): Promise<MadeRead | null> {
  const had = kept.get(slug);
  if (had && now - had.at < KEEP_MS) return had.read;
  const demo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  const read = fetch(`/api/ai/history?project=${encodeURIComponent(slug)}${demo ? '&demo=1' : ''}`, { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await res.json() as { rows?: unknown; next?: unknown };
      return Array.isArray(data.rows)
        ? { rows: data.rows as MadeRead['rows'], next: typeof data.next === 'string' ? data.next : null }
        : null;
    })
    .catch(() => null);
  kept.set(slug, { at: now, read });
  return read;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('homeroom-bot-work-changed', () => kept.clear());
}

/** Whether the Workshop asks this viewer who should build, in Your work's place, and the ✕'s action. */
export function useFirstChange(slug: string, desk: DeskSummary): { show: boolean; close: () => void } {
  const [made, setMade] = useState<MadeRead | null>(null);
  const [closed, close] = useHubDismissed(slug, 'first');
  const readOnly = useStoreState(improveStore).readOnly;
  // Only once the desk says there is nothing of theirs here now: most members never ask History.
  const empty = desk.ready && desk.needs + desk.progress + desk.waiting === 0;
  useEffect(() => {
    setMade(null);
    if (!slug || !empty || closed || readOnly) return undefined;
    let live = true;
    void readMade(slug).then((read) => { if (live) setMade(read); });
    return () => { live = false; };
  }, [slug, empty, closed, readOnly]);
  return { show: !closed && !readOnly && firstChangeFor(desk, made), close };
}

function BuilderTile({ builder }: { builder: BotNewBuilder }): ReactNode {
  if (builder === 'homeroom') return <img src={BOT_AVATAR} alt="" className="h-[34px] w-[34px] shrink-0 rounded-[10px] object-cover" />;
  const Glyph = builder === 'claude-code' ? TerminalIcon : ChatIcon;
  return (
    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900" aria-hidden="true">
      <Glyph className="h-5 w-5" />
    </span>
  );
}

/** The card itself: three links, each to a new thread set to this project and that builder. */
export function FirstChangeCard({ slug, onClose }: { slug: string; onClose: () => void }): ReactNode {
  const t = useMessages('project');
  // Which products already have Homeroom's connector: a row without one says Set up.
  const [connected, setConnected] = useState<Record<OwnBuilder, boolean> | null>(null);
  useEffect(() => {
    let live = true;
    void listConnectors().then((rows) => { if (live) setConnected(connectedBuilders(rows)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <section className="dev-ws-strip dev-ws-first" data-ws-first-change="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{t('project:workshop.first.title')}</span>
        <HubCardClose card="first" onClose={onClose} />
      </div>
      <p className="dev-ws-strip-text">{t('project:workshop.first.text')}</p>
      <div role="group" aria-label={t('project:workshop.first.label')} className="flex flex-col">
        {BOT_NEW_BUILDERS.map((builder) => {
          const own = builder === 'homeroom' ? null : builder;
          const needsSetup = !!own && !!connected && !connected[own];
          return (
            <ListRow
              key={builder}
              as="a"
              href={botNewAddress({ project: slug, builder })}
              inset="none"
              className="rounded-[14px] px-1 py-2"
              data-ws-first-builder={builder}
              // One thing at the row's end (AGENTS.md, "At most one pill on a list row"): Set up, or the chevron.
              chevron={!needsSetup}
              leading={<BuilderTile builder={builder} />}
              title={own ? BUILDER_NAME[own] : t('project:workshop.first.homeroom.name')}
              subtitle={own
                ? t('project:workshop.first.own', { product: BUILDER_PRODUCT[own] })
                : t('project:workshop.first.homeroom.sub')}
              trailing={needsSetup ? (
                <span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300" data-ws-first-setup="">
                  {t('project:workshop.first.setUp')}
                </span>
              ) : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}
