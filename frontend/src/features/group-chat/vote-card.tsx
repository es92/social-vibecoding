/**
 * #6236: what a chat line about a change offers in place of the old inline
 * vote row.
 *
 * Under Homeroom bot's "I built this. It's up for a vote: …" post, and under
 * a thread's vote lines, there used to be a row of small old-style buttons
 * filled by group-chat.js from AppView's own markup: "0 of 1 approval ·
 * Preview · Yes (0✓) · No (0✓) · Admin merge". It did not say what it was
 * voting on, and a one-click Admin merge in a chat line was easy to press by
 * mistake. Two forms replace it, both React's end to end:
 *
 *   * `VoteLine` — on a request's page, where the change's section is drawn
 *     below (../dev-board/topic/thread-changes.tsx): one line that names the
 *     change ("Change #6063 · Dark mode") and offers See the vote, which
 *     brings that section's bar into view (./votes-in-view.ts). No vote of
 *     its own: the section below has the change page's bar and its Vote.
 *   * `VoteCard` — anywhere else a line about a change is drawn (a project's
 *     channel, a topic's thread, the change's own Discussion): the bar a
 *     change's page ends with (../dev-board/topic/thread-card.tsx
 *     ThreadFoot), in a small card. Its headline names the change, its line
 *     says where the vote and checks stand ("Needs 1 more yes · All checks
 *     passed"), and its buttons are Preview and the change page's own Vote
 *     (../dev-board/card/dev-card.tsx VoteButton), which opens the same "Your
 *     vote" picker there as everywhere and sends `AppView.castVote`. Where
 *     the viewer has no vote to cast here (signed out, view only, the change
 *     settled or not in the snapshot yet), See the vote opens the change at
 *     its vote instead. While the vote is open it is the card's main action
 *     and wears the Vote button's own paint (.dev-vote-btn, the bar's
 *     yellow); once the change is settled it is a plain pill, since a done
 *     thing gets no fill. Admin merge stays in the change's ⋯ menu
 *     (AppView._proposalMenuItems), admins only, never inline in a chat line.
 *
 * The facts come off the row's model (`msg.vote`, transcript-store.ts
 * VoteView), which group-chat.js resolves from `AppView.voteState` and
 * patches in whenever the snapshot moves (`refreshVoteControls`). Nothing in
 * public/js writes a node below either component.
 */

import type { ReactNode } from 'react';

import { EyeIcon } from '@/components/ui/icons';

import { projectChangesOnGithub } from '../../lib/change-ref';
import { useMessages } from '../../lib/i18n/react';
import { checksWords, myVoteWords, voteStanding, type ChangeWords } from '../dev-board/card/change';
import { VoteButton } from '../dev-board/card/dev-card';
import type { ActionSpec } from '../dev-board/card/model';
import { ThreadFoot } from '../dev-board/topic/thread-card';
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
  // Each fact is a phrase of the one model of a change
  // (../dev-board/card/change.ts), which the preview's bar says too.
  const said = (words: ChangeWords | null): string[] => (words ? [t(words.id, words.values)] : []);
  // Decided: it went live, or is going live, and that is all it says.
  if (vote.status === 'merged' || vote.status === 'merging') return said(voteStanding(vote));
  // T2.12: not open for votes, by the change's stored row: where it stands
  // in that row's words ("Taking screenshots · Tests passed: only the before
  // and after screenshots are left"), and the viewer's own vote.
  if (vote.work && vote.work.stage) {
    return [
      t(vote.work.stage.id, vote.work.stage.values),
      ...(vote.work.line ? [t(vote.work.line.id, vote.work.line.values)] : []),
      ...said(myVoteWords(vote)),
    ];
  }
  return [
    ...said(voteStanding(vote)),
    ...said(myVoteWords(vote)),
    ...said(checksWords(vote.checks)),
    ...(vote.preview?.kind === 'building' ? [t('chat:group.voteCard.previewBuilding')] : []),
  ];
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
export function VoteLine({ sessionId, number, title, live = false }: { sessionId: number; number: number | null; title: string | null; live?: boolean }): ReactNode {
  const t = useMessages('chat');
  // Once the change is live its vote is over: the line offers the change
  // itself, whose section the same press scrolls to (phone review #116).
  return (
    <div className="gc-vote-line" data-vote-line={sessionId}>
      <span className="gc-vote-line-name">{changeName(t, { number, title })}</span>
      {' · '}
      <button type="button" className="dev-request-event-link" data-vote-see="" onClick={() => askVotesInView(sessionId)}>
        {live ? t('chat:group.voteCard.seeChange') : t('chat:group.voteCard.seeVote')}
      </button>
    </div>
  );
}

/**
 * The change's Yes and No as the one vote control takes them: the pair its
 * card and its page draw (`AppView._cardVoteButtonSpecs`, from the change's
 * row in the vote snapshot, with the approval epoch the server checks). Null
 * where the viewer has no vote to cast here: signed out, view only, or the
 * change not up for a vote in the snapshot.
 */
export function changeVoteSpecs(sessionId: number | null): { yes: ActionSpec; no: ActionSpec } | null {
  if (typeof window === 'undefined' || !sessionId) return null;
  const w = window as any;
  const av = w.AppView;
  if (!w.App?.user || !av || av.readOnly || typeof av._cardVoteButtonSpecs !== 'function') return null;
  const row = av.voteState?.bySession?.[String(sessionId)] || null;
  const pair: ActionSpec[] = row ? av._cardVoteButtonSpecs(row) || [] : [];
  const yes = pair.find((a) => a.key === 'yes');
  const no = pair.find((a) => a.key === 'no');
  return yes && no ? { yes, no } : null;
}

/**
 * Everywhere else: the change page's bar, in a small card. Its headline is
 * the snapshot's title when there is one, else the number the row itself
 * carries; its line is the row's `vote`.
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
  const specs = vote && !settled ? changeVoteSpecs(sessionId) : null;
  return (
    <div
      className="gc-vote-card"
      role="group"
      aria-label={t('chat:group.voteCard.label')}
      data-vote-card={sessionId ?? ''}
      data-vote-state={vote ? vote.status : 'unknown'}
    >
      <ThreadFoot
        what="vote"
        headline={changeName(t, { number, title: vote?.title ?? null })}
        sub={facts.length ? facts.join(' · ') : null}
        tone={settled ? 'muted' : null}
      >
        {preview && sessionId ? (
          <button
            type="button"
            className="gc-vote-btn gc-vote-btn-preview"
            data-vote-preview=""
            onClick={() => (window as any).AppView?.swapToStagingForSession?.(sessionId, preview, { title: vote?.title ?? null, number: number ?? null })}
          >
            <EyeIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t('chat:group.voteCard.preview')}
          </button>
        ) : null}
        {specs ? <VoteButton yes={specs.yes} no={specs.no} /> : (
          <button type="button" className={settled ? 'gc-vote-btn' : 'dev-vote-btn'} data-vote-open="" onClick={() => openVotes(sessionId, number)}>
            {t('chat:group.voteCard.seeVote')}
          </button>
        )}
      </ThreadFoot>
    </div>
  );
}
