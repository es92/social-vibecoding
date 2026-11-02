import { useMessages } from '../../lib/i18n/react';
import { appTabSlug, newsIcon } from './bot-shared';
import { useBotWork } from './bot-work';
import { MessageMarkdown, ObjectCard } from './format';
import { pageOf, sameItem, type HomeroomLink } from './homeroom-links';
import { useLinkCards } from './link-cards';
import type { HomeroomBotMeta, SharedObjectCard } from './types';

/*
 * #4097: what a Homeroom bot message is about, as its card.
 *
 * The bot names what a message is about in a line of its own, a paragraph
 * by itself, and its words follow after a blank line
 * (services/homeroom-bot-dm.js requestLine, and the offers in
 * services/homeroom-bot-mayor.js). In the transcript each line was bold text
 * and a number to decode. The row now draws the card that line names in its
 * place (./format.tsx ObjectCard, the card a shared item is):
 *
 *   "**Todo List** · request #93: Only close…"   the request's card
 *   "**Todo List**, its first version"           the project's card
 *   "**Todo List**" (setting up, or it failed)   the project's card
 *   "**Todo List** · proposal: Plant photos"     the change's card (an offer to withdraw it)
 *   "**Todo List** · new request: Dark mode"     a request not filed yet (an offer to file it)
 *
 * A line counts only on the bot's own message (botMeta is null for anyone
 * else) and only about what its metadata names: the same request number, or
 * the same project name. News leads with its line; the maker's hello comes
 * before the project's line; an offer's line follows the bot's reply.
 *
 * THE MESSAGE IS UNCHANGED. Its text still carries the line, so the inbox
 * preview, the bell, a push, a quote and Copy text still name it in words;
 * only the transcript draws it as a card, so every message the bot already
 * sent reads the new way too.
 *
 * WHERE A REQUEST'S CARD COMES FROM, best first: the request's card the
 * message already carries (drawn here instead of again under the words); the
 * server's reading of it for this reader, the one a pasted link to it gets
 * (./link-cards.tsx); and, until that answers or when it cannot, the card the
 * line itself describes, which says nothing the line did not. A change's
 * card is the one the offer carries. A project's card and a draft's are the
 * line's own: there is nothing more to read.
 *
 * NO "BY" AND NO STATUS on a request's card. On a request the platform filed,
 * GitHub's author is its own account. The status is GitHub's: a request whose
 * change went live is "closed", so "It's live now" sat under a card reading
 * "Todo List · closed", which reads as turned down. The words say where it
 * stands. A change's status is the platform's own words, and stays.
 *
 * ONE WAY IN. A first version that went live carries an Open button for the
 * same project, which a project card would only repeat: its line goes and
 * no card stands in.
 */

export type HeadKind = 'request' | 'project' | 'change' | 'draft';

export interface BotHead {
  kind: HeadKind;
  /** The page the card opens (a request's, a project's App tab), or null when there is none to open. */
  link: HomeroomLink | null;
  /** The project the message names, for the words' `#N` chips (#3770). */
  appSlug: string | null;
  appName: string;
  /** A request's number; null for anything else. */
  issueNumber: number | null;
  /** The request's, change's or draft's title as the bot knew it; null for a project. */
  title: string | null;
  /** The words before the line (the maker's hello, an offer's reply); '' for news. */
  before: string;
  /** The words after the line; '' when there are none. */
  rest: string;
  /** The line goes without a card: the message's own Open button opens the same project. */
  hidden: boolean;
  /** The project's emoji icon, when the message carries it (`appEmoji`). */
  appEmoji?: string;
}

// requestLine's shapes, and the offers'. The name is matched against the
// metadata's, except on a request line, which names its number instead.
const REQUEST_LINE = /^\*\*(.+?)\*\* · request #(\d+)(?:: (.+))?$/;
const FIRST_VERSION_LINE = /^\*\*(.+)\*\*, its first version$/;
const PROJECT_LINE = /^\*\*(.+)\*\*$/;
const OFFER_LINE = /^\*\*(.+?)\*\* · (proposal|new request): (.+)$/;

type Parsed = Pick<BotHead, 'kind' | 'appName' | 'issueNumber' | 'title'>;

/** Pure: what one paragraph names, when it is one of the bot's lines about what `meta` names. */
function lineOf(paragraph: string, meta: HomeroomBotMeta): Parsed | null {
  const text = paragraph.trim();
  if (meta.kind === 'confirm') {
    const offer = OFFER_LINE.exec(text);
    if (!offer || offer[1] !== meta.appName) return null;
    // 31 Oct 2026: a draft that File it filed carries its number
    // (homeroom-bot-mayor.js settleOffer), and is drawn as the request it
    // became. It kept saying "not filed yet" after it was filed as #6071.
    const filed = Number(meta.issueNumber);
    if (offer[2] === 'new request' && Number.isInteger(filed) && filed > 0) {
      return { kind: 'request', appName: offer[1], issueNumber: filed, title: meta.issueTitle || offer[3] };
    }
    return { kind: offer[2] === 'proposal' ? 'change' : 'draft', appName: offer[1], issueNumber: null, title: offer[3] };
  }
  const request = REQUEST_LINE.exec(text);
  if (request) {
    const n = Number(meta.issueNumber);
    if (meta.firstVersion || !Number.isInteger(n) || n <= 0 || Number(request[2]) !== n) return null;
    return { kind: 'request', appName: meta.appName || request[1], issueNumber: n, title: meta.issueTitle || request[3] || null };
  }
  const project = FIRST_VERSION_LINE.exec(text) || PROJECT_LINE.exec(text);
  if (project && meta.appName && project[1] === meta.appName) {
    return { kind: 'project', appName: project[1], issueNumber: null, title: null };
  }
  return null;
}

/**
 * Pure: the line about what `meta` names, split from the words around it.
 * Null for anything else: a person's message, a line about another request
 * or project, or words that only look like one somewhere it does not stand.
 */
export function botHead(content: string, meta: HomeroomBotMeta | null): BotHead | null {
  if (!meta) return null;
  const paragraphs = String(content || '').split('\n\n');
  // Where the line may stand: anywhere in an offer, after the maker's hello,
  // else first.
  const at = meta.kind === 'confirm'
    ? paragraphs.findIndex((p) => lineOf(p, meta))
    : meta.hello && paragraphs[0].trim() === meta.hello.trim() ? 1 : 0;
  const parsed = at >= 0 && at < paragraphs.length ? lineOf(paragraphs[at], meta) : null;
  if (!parsed) return null;
  const slug = meta.appSlug || null;
  let link: HomeroomLink | null = null;
  if (slug && parsed.kind === 'request') link = pageOf(`app/${slug}/dev/issues/${parsed.issueNumber}`);
  if (slug && parsed.kind === 'project') link = pageOf(`app/${slug}/app`);
  return {
    ...parsed,
    link,
    appSlug: slug,
    before: paragraphs.slice(0, at).join('\n\n').trim(),
    rest: paragraphs.slice(at + 1).join('\n\n').trim(),
    hidden: parsed.kind === 'project' && !!slug
      && (meta.actions || []).some((action) => action.type === 'open' && appTabSlug(action.target) === slug),
    ...(parsed.kind === 'project' && meta.appEmoji ? { appEmoji: meta.appEmoji } : {}),
  };
}

/** Whether a card on the message is the one `head` draws, so it is not drawn twice. */
export function isHeadCard(head: BotHead | null, object: SharedObjectCard): boolean {
  if (!head || head.hidden) return false;
  if (head.kind === 'change') return object.type === 'proposal' && !!head.appSlug && object.appSlug === head.appSlug;
  return head.kind === 'request' && !!head.link && sameItem(head.link, object);
}

const NO_LINKS: readonly HomeroomLink[] = [];

/** The card the line names, from the best source there is (above). */
export function BotHeadCard({ head, objects }: { head: BotHead; objects: readonly SharedObjectCard[] }) {
  const t = useMessages('messages');
  const carried = objects.find((object) => object.available && isHeadCard(head, object)) || null;
  // A project's card wears the project's own icon (run four, 13 Oct: it was
  // "◆"): the tray's, as the strip and the news lines draw it, else the
  // emoji the message carries, else (B21, overnight audit, 1 Nov 2026) the
  // project's own hub card, read for its icon alone: a newcomer's first
  // project is in none of the tray's lists once it is live, and its icon is
  // an image the message never carried. With none of them, the glyph.
  const { work } = useBotWork();
  const tray = head.kind === 'project' ? newsIcon(work, head.appSlug, head.appName) : null;
  const iconless = head.kind === 'project' && !!head.appSlug && !tray?.iconUrl && !tray?.iconEmoji && !head.appEmoji;
  const hub = iconless ? pageOf(`app/${head.appSlug}/workshop`) : null;
  const [read] = useLinkCards(carried ? NO_LINKS
    : head.kind === 'request' && head.link ? [head.link]
      : hub ? [hub] : NO_LINKS);
  const fetched = read?.card?.available ? read.card : null;
  const icon = head.kind !== 'project' ? null
    : iconless && fetched ? { iconUrl: fetched.iconUrl || null, iconEmoji: fetched.iconEmoji || null } : tray;
  const own: SharedObjectCard = {
    type: head.kind === 'project' ? 'app' : head.kind === 'change' ? 'proposal' : 'issue',
    available: true,
    appSlug: head.appSlug || undefined,
    issueNumber: head.issueNumber || undefined,
    title: head.kind === 'project' ? head.appName : head.title || t('messages:bot.head.requestNumber', { number: String(head.issueNumber) }),
    subtitle: head.kind === 'project' ? t('messages:bot.head.firstVersion')
      : head.kind === 'draft' ? t('messages:bot.head.notFiled', { project: head.appName }) : head.appName,
    ...(icon && (icon.iconUrl || icon.iconEmoji || head.appEmoji)
      ? { iconUrl: icon.iconUrl, iconEmoji: icon.iconEmoji || head.appEmoji || null } : {}),
  };
  const card = carried || (head.kind === 'request' ? read?.card : null) || own;
  const quiet = head.kind === 'request' ? { author: null, state: null } : { author: null };
  return (
    <div className="mb-1.5 mt-1 max-w-[480px]" data-bot-head-card={head.kind} data-bot-request-card={head.issueNumber || undefined}>
      <ObjectCard object={{ ...card, ...quiet, href: head.link?.href || (head.kind === 'change' ? card.href : null) || null }} />
    </div>
  );
}

/** The words before the line, the card it names, then the words after it. */
export function BotHeadWords({ head, objects, channels }: {
  head: BotHead;
  objects: readonly SharedObjectCard[];
  channels?: ReadonlySet<string>;
}) {
  const words = (text: string) => (text ? <MessageMarkdown content={text} channels={channels} appSlug={head.appSlug} /> : null);
  if (head.hidden) return words([head.before, head.rest].filter(Boolean).join('\n\n'));
  return (
    <>
      {words(head.before)}
      <BotHeadCard head={head} objects={objects} />
      {words(head.rest)}
    </>
  );
}
