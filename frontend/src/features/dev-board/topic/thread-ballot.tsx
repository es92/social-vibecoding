/**
 * #6019 (threads, stage 6): competing changes in one thread, as one ballot,
 * where a page draws the thread as a list (./thread-items.tsx): a change's
 * own page. A request's page draws the same ballot with its changes
 * (./thread-changes.tsx `Competing`, which this is): a short row per change,
 * then one Votes card with a bar and a button per choice. An open vote to
 * close the thread competes with the changes, and Close it takes Neither's
 * place.
 *
 * A pick is ordinary votes, cast the platform's own way (AppView.castVote /
 * retractVote with each change's approval epoch, castIssueVote for the
 * close): each change keeps its own vote underneath, so a push to one clears
 * only its own.
 */

import type { ReactNode } from 'react';

import { Competing } from './thread-changes';
import { ballotOf, type ThreadHere, type ThreadPayload } from './thread-model';

/**
 * The ballot a change's page is on: the changes that would close one of the
 * requests it closes (./thread-model.ts ballotOf), and a vote to close filed
 * on one of them. Nothing for a change that closes nothing, or competes with
 * nothing.
 */
export function ThreadBallot({ slug, data, here, onChanged }: {
  slug: string | null; data: ThreadPayload; here: ThreadHere; onChanged: () => void;
}): ReactNode {
  const own = here.type === 'change' ? data.items.find((i) => i.type === 'change' && i.id === here.id) : null;
  const anchor = own ? (own.closes || []) : [];
  if (here.type === 'change' && !anchor.length) return null;
  const ballot = ballotOf(data, anchor);
  if (!ballot) return null;
  return (
    <Competing key={ballot.options.map((o) => o.id).join(',')} slug={slug} data={data} anchor={anchor}
      options={ballot.options} close={ballot.close} onChanged={onChanged} />
  );
}
