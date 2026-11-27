/**
 * #6440: a governance vote's page — a rename, a secret change, a
 * maintenance campaign, a new featured picture, or a vote to close a request
 * — drawn in the thread layout a request's and a change's page use
 * (../../group-chat/thread-shell.tsx `RequestShell`, its decision layout).
 *
 * This is the head: everything the governance row says. It renders into
 * `#gc-thread-head` and portals the two pieces every such page has into the
 * shell's other hosts:
 *
 *   - `#gc-thread-back`: the "‹ Workshop" chip, above the sheet;
 *   - `#gc-thread-bar`: the sheet's header, "Rename #N" (the kind in words
 *     and its number), its status pill, and the ⋯ disc. Its rows are the
 *     card menu's (`AppView._registerCardMenu`: Copy link, and Withdraw for
 *     its proposer), so the disc carries `data-card-menu`.
 *
 * Then, in the root post: who proposed it and when, the vote's title, what
 * it does in plain words, and its Votes card (`./thread-changes.tsx`
 * GovVote) with the votes cast under it in the voters' own words. The
 * replies follow in `#gc-thread-messages`, the proposal's own governance
 * thread.
 *
 * A secret change names its key and never its value: the server strips the
 * ciphertext (routes/issues.js) and ./governance-model.ts has no field for
 * one.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { Avatar } from '@/components/ui/feed';
import { EllipsisHorizontalIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { ChangeTag, IllustrationPreviewRow } from '../card/dev-card';
import type { StatusPillState } from '../card/model';
import { Roster } from './topic-head';
import { TopicBack } from './topic-back';
import { governanceView, outcomeLine, type GovernanceView } from './governance-model';
import { GovVote } from './thread-changes';

function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/** The pill an ended vote wears: its ending, in the pill's own shape. */
function endedPill(g: GovernanceView, t: (id: string) => string): StatusPillState | null {
  const id = outcomeLine(g.votes.outcome);
  if (!id) return null;
  return {
    tier: 1, key: g.votes.outcome, label: t(id), tone: 'neutral',
    yes: g.votes.yes, no: 0, majority: 1, advisory: 0, lock: false,
    ...(g.votes.outcome === 'applying' ? { spinner: true, tone: 'progress' } : {}),
  };
}

/** The sheet's header: what kind of vote this is and its number, its status, and ⋯. */
export function GovernanceBar({ g }: { g: GovernanceView }): ReactNode {
  const t = useMessages('project');
  const pill = g.votes.open ? (g.pill as StatusPillState | null) : endedPill(g, translate);
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="messages-thread-kicker min-w-0" data-gov-kicker="">{t(g.kicker.id, g.kicker.values)}</div>
          {pill ? <span className="shrink-0" data-gov-status={pill.key}><ChangeTag s={pill} /></span> : null}
        </div>
        <div className="messages-thread-name line-clamp-2 dev-request-bar-title" data-gov-bar-title={g.id}>{g.title}</div>
      </div>
      {g.menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={g.menuKey}
          aria-haspopup="true"
          aria-label={t('project:topic.decision.bar.more')}
          title={t('project:topic.decision.bar.more')}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

/** What the vote does, in its kind's own words. */
function GovernanceWhat({ g }: { g: GovernanceView }): ReactNode {
  const t = useMessages('project');
  const c = g.content;
  if (c.kind === 'rename') {
    return (
      <p className="mt-1.5 text-[15px] text-zinc-700 dark:text-zinc-300" data-gov-content="rename">
        <RichMessage
          id="project:topic.decision.rename.fromTo"
          values={{ from: c.from || '?', to: c.to }}
          components={[<strong />, <strong />]}
        />
      </p>
    );
  }
  if (c.kind === 'secret') {
    return (
      <p className="mt-1.5 text-[15px] text-zinc-700 dark:text-zinc-300" data-gov-content="secret">
        <RichMessage
          id={c.action === 'remove' ? 'project:topic.decision.secret.remove' : 'project:topic.decision.secret.set'}
          values={{ key: c.key }}
          components={[<code className="rounded bg-zinc-100 px-1 py-0.5 text-[13px] dark:bg-zinc-800" />]}
        />
      </p>
    );
  }
  if (c.kind === 'campaign') {
    return (
      <p className="mt-1.5 whitespace-pre-line text-[15px] text-zinc-700 dark:text-zinc-300" data-gov-content="campaign">
        {c.description || t('project:topic.decision.campaign.empty')}
      </p>
    );
  }
  if (c.kind === 'illustration') {
    return (
      <div data-gov-content="illustration">
        <IllustrationPreviewRow x={{ t: 'illustration', key: `gov:${g.id}`, proposed: c.proposed, current: c.current, remove: c.remove }} />
      </div>
    );
  }
  return (
    <div data-gov-content="close">
      {c.number ? (
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          <RichMessage
            id="project:topic.decision.close.request"
            values={{ number: c.number, title: c.title }}
            components={[<span className="font-semibold" />]}
          />
        </p>
      ) : null}
      {c.reason ? <p className="mt-1.5 whitespace-pre-line text-[15px] text-zinc-700 dark:text-zinc-300">{c.reason}</p> : null}
    </div>
  );
}

/**
 * The model for one published row: what AppView knows (the viewer's name,
 * the ⋯ menu's rows, the roster it read) applied to ./governance-model.ts.
 * The page publishes the ROW and this reads it, so a repaint that only
 * refreshed the roster redraws the same page with it.
 */
function viewOf(row: any): GovernanceView {
  // `window` may be absent (the head is also rendered server-side by the
  // topic-head tests), so every global is reached through one guarded read.
  // `typeof (window as any).X` alone would not do: its operand is evaluated
  // first, so it throws on an undefined `window`.
  const win: any = typeof window === 'undefined' ? null : (window as any);
  const av = win ? win.AppView : null;
  const app = win ? win.App : null;
  const id = Number(row && row.id) || 0;
  const menuKey = av && typeof av._registerCardMenu === 'function'
    ? av._registerCardMenu(`gov:${id}:decision`, av._govDecisionMenu?.(row) || [])
    : '';
  const pill = av && typeof av._govCardModel === 'function'
    ? (av._govCardModel(row, { noNav: true }) || {}).pill?.state || null
    : null;
  const stamp = win && typeof win.GroupChat?._stamp === 'function' && row && row.created_at
    ? win.GroupChat._stamp(row.created_at) : null;
  return governanceView(row, {
    username: app && app.user ? app.user.username : '',
    appName: av && av.appData ? av.appData.name : '',
    menuKey,
    roster: av && av._govVoteRoster ? av._govVoteRoster[id] || null : null,
    atText: stamp ? stamp.text : '',
    pill,
  });
}

/**
 * A governance vote's head. `row` is the governance row the page published
 * (AppView `_renderTopicHead` → topicHeadStore) on every repaint, so the
 * roster and the tally keep up with the vote. `view` is the model, for a
 * caller that already has it (the tests).
 */
export function GovernanceHead({ row, view = null }: { row: any; view?: GovernanceView | null }): ReactNode {
  const g = view || viewOf(row);
  const t = useMessages('project');
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  const who = g.by || t('project:topic.thread.page.someone');
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<GovernanceBar g={g} />, bar) : null}
      <article className="messages-message dev-request-root" data-gov-root={g.id}>
        <Avatar shape="square" size="sm" color={swatchFor(who)} aria-hidden="true">
          {(who || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="messages-message-head">
            <span className="messages-message-author">{who}</span>
            {g.atText ? <time dateTime={g.at || undefined}>{g.atText}</time> : null}
          </div>
          <h1 className="dev-request-title" data-gov-title={g.id}>{g.title}</h1>
          <GovernanceWhat g={g} />
          <GovVote g={g} />
          {g.roster ? <div className="dev-topic-roster"><Roster r={g.roster} /></div> : null}
        </div>
      </article>
    </>
  );
}
