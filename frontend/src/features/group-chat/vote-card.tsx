/**
 * #6236: what a chat line about a change offers in place of the old inline
 * vote row.
 *
 * Under Homeroom bot's "I built this. It's up for a vote: …" post, and under
 * a thread's vote lines, there used to be a row of small old-style buttons
 * filled by group-chat.js from AppView's own markup: "0 of 1 approval ·
 * Preview · Yes (0✓) · No (0✓) · Admin merge". It did not say what it was
 * voting on, it repeated what the page already shows better (since one page
 * per thread, a change built for a request has its section on the request's
 * page, with its Votes card, its Tested card and its Preview), and a
 * one-click Admin merge in a chat line was easy to press by mistake. Two
 * forms replace it, both React's end to end:
 *
 *   * `VoteLine` — on a request's page, where the change's section is drawn
 *     below (../dev-board/topic/thread-changes.tsx): one line that names the
 *     change ("Change #6063 · Dark mode") and offers See the vote, which
 *     brings that section's Votes card into view (./votes-in-view.ts) — the
 *     same door the notifications and the first version's "See the change"
 *     use. No Yes, no No, no Admin merge: the card below has the vote, and
 *     Admin merge stays in the change's ⋯ menu (AppView._proposalMenuItems),
 *     admins only, never inline in a chat line.
 *   * `VoteCard` — anywhere else a line about a change is drawn (a project's
 *     channel, a topic's thread, the change's own Discussion): a small card
 *     in today's style naming the change, where its vote and checks stand in
 *     words ("Needs 1 more yes · All checks passed"), and Preview and Vote,
 *     which open the change's preview and its Votes card.
 *
 * The facts come off the row's model (`msg.vote`, transcript-store.ts
 * VoteView), which group-chat.js resolves from `AppView.voteState` and
 * patches in whenever the snapshot moves (`refreshVoteControls`). Nothing in
 * public/js writes a node below either component.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { projectChangesOnGithub } from '../../lib/change-ref';
import { useMessages } from '../../lib/i18n/react';
import { askVotesInView } from '../dev-board/topic/votes-in-view';
import type { TranscriptMessage, VoteView } from './transcript-store';

type T = (id: string, values?: Record<string, string | number>) => string;

/** How the card names its change: "Change #12 · Dark mode", "PR 12", the title alone, or "A change". */
export function changeName(t: T, { number, title }: { number: number | null; title: string | null }, github = projectChangesOnGithub()): string {
  const name = number ? t(github ? 'chat:group.voteCard.changePr' : 'chat:group.voteCard.change', { number }) : '';
  if (name && title) return t('chat:group.voteCard.changeTitled', { name, title });
  return name || title || t('chat:group.voteCard.unnamed');
}

/**
 * Pure: the facts the card says, in order — the vote, the viewer's own
 * vote, the checks, and the preview still building. Empty while the change
 * is unknown to the snapshot, when the card shows its name and doors alone.
 */
export function voteFacts(t: T, vote: VoteView | null | undefined): string[] {
  if (!vote) return [];
  if (vote.status === 'merged') return [t('chat:group.voteCard.merged')];
  if (vote.status === 'merging') return [t('chat:group.voteCard.merging')];
  const facts: string[] = [];
  const yes = vote.yes ?? 0;
  const needed = vote.needed ?? 1;
  if (yes < needed) facts.push(t('chat:group.voteCard.needsMore', { count: needed - yes }));
  else if (vote.needsOtherMember) facts.push(t('chat:group.voteCard.needsOtherMember'));
  else facts.push(t('chat:group.voteCard.reached', { yes, needed }));
  if (vote.myVote === 'yes') facts.push(t('chat:group.voteCard.youVotedYes'));
  else if (vote.myVote === 'no') facts.push(t('chat:group.voteCard.youVotedNo'));
  if (vote.checks === 'passing') facts.push(t('chat:group.voteCard.checks.passed'));
  else if (vote.checks === 'failing') facts.push(t('chat:group.voteCard.checks.failing'));
  else if (vote.checks === 'pending') facts.push(t('chat:group.voteCard.checks.running'));
  else if (vote.checks === 'error') facts.push(t('chat:group.voteCard.checks.error'));
  if (vote.preview?.kind === 'building') facts.push(t('chat:group.voteCard.previewBuilding'));
  return facts;
}

/** The chat's project, as the module that mounted it knows it (GroupChat.appSlug), else the open app's. */
function chatSlug(): string | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.GroupChat?.appSlug || w.AppView?.appData?.slug || null;
}

/** The door to a change's Votes card: its page opened at the card (AppView.openChangeAtVotes), or, with only a pull request number, its address. */
function openVotes(sessionId: number | null, number: number | null): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  const slug = chatSlug();
  if (!slug) return;
  if (sessionId) {
    if (typeof w.AppView?.openChangeAtVotes === 'function') w.AppView.openChangeAtVotes(slug, sessionId);
    else {
      askVotesInView(sessionId);
      w.location.hash = `#app/${encodeURIComponent(slug)}/dev/proposals/${sessionId}`;
    }
  } else if (number) {
    w.location.hash = `#app/${encodeURIComponent(slug)}/dev/changes/${number}`;
  }
}

/**
 * On a request's page: the line under a post about one of the request's
 * changes. `number` and `title` come from the page's own reading of its
 * thread (request-model.ts requestChangesStore), so the line needs no vote
 * snapshot: the section below carries the vote.
 */
export function VoteLine({ sessionId, number, title }: { sessionId: number; number: number | null; title: string | null }): ReactNode {
  const t = useMessages('chat');
  return (
    <div className="gc-vote-line" data-vote-line={sessionId}>
      <span className="gc-vote-line-name">{changeName(t, { number, title })}</span>
      {' · '}
      <button type="button" className="dev-request-event-link" data-vote-see="" onClick={() => askVotesInView(sessionId)}>
        {t('chat:group.voteCard.seeVote')}
      </button>
    </div>
  );
}

/**
 * Everywhere else: the small card. Its facts are the row's `vote`; its name
 * is the snapshot's title when there is one, else the number the row itself
 * carries.
 */
export function VoteCard({ msg }: { msg: TranscriptMessage }): ReactNode {
  const t = useMessages('chat');
  const ref = msg.voteRef;
  if (!ref) return null;
  const vote = msg.vote ?? null;
  const sessionId = Number(vote?.sessionId || ref.sessionId) || null;
  const number = vote?.number ?? (Number(ref.prNumber) || null);
  const facts = voteFacts(t, vote);
  const settled = !!vote && vote.status !== 'promoted';
  const preview = vote?.preview?.kind === 'live' ? vote.preview.url : null;
  return (
    <div
      className="gc-vote-card"
      role="group"
      aria-label={t('chat:group.voteCard.label')}
      data-vote-card={sessionId ?? ''}
      data-vote-state={vote ? vote.status : 'unknown'}
    >
      <div className="gc-vote-card-name">{changeName(t, { number, title: vote?.title ?? null })}</div>
      {facts.length ? <div className="gc-vote-card-facts" data-vote-facts="">{facts.join(' · ')}</div> : null}
      <div className="gc-vote-card-actions">
        {preview && sessionId ? (
          <Button
            type="button"
            variant="pillOnCard"
            size="sm"
            ink="neutral"
            data-vote-preview=""
            onClick={() => (window as any).AppView?.swapToStagingForSession?.(sessionId, preview, { title: vote?.title ?? null, number: number ?? null })}
          >
            {t('chat:group.voteCard.preview')}
          </Button>
        ) : null}
        <Button type="button" variant="pillAccent" size="sm" data-vote-open="" onClick={() => openVotes(sessionId, number)}>
          {settled ? t('chat:group.voteCard.seeVote') : t('chat:group.voteCard.vote')}
        </Button>
      </div>
    </div>
  );
}
