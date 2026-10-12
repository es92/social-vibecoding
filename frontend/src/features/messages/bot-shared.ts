import { t } from '../../lib/i18n/runtime';
import type { ConversationMessage, HomeroomBotActivityOutcome, HomeroomBotJob, HomeroomBotMeta } from './types';

/*
 * What the Homeroom bot's activity tray (./bot-work.tsx), its activity cards
 * (./bot-activity.tsx), its plan layout (./bot-plan.tsx) and its change
 * blocks (#4564, ./index.tsx) all need: how a piece of work is named, the
 * window event that says the bot's work moved on, and the request a bot
 * message is about. A module of its own so they can share it without
 * importing each other. It imports types and the message runtime only, and
 * reads a message's metadata inline — the other modules' own rule.
 */

/*
 * ── Threads in the chat with Homeroom bot ──────────────────────────────
 * Every request the bot works on for someone has one story: an activity
 * card in their chat with the bot, which is the root of that request's own
 * reply thread (services/homeroom-bot-activity.js). Its quiet step lines,
 * questions, plan, answers and ending are replies in that thread, and the
 * four moments that ring (needs you, ready to try, stopped, live) are also
 * listed in the main chat (`alsoInChat`), drawn there as the full message
 * under a "↳ in {request} · {project}" label that opens the thread.
 *
 * A direct chat between people keeps no threads (#2387): a thread is how a
 * room keeps a side conversation out of everyone's way, and a DM has no one
 * else in it. The chat with the bot is the one exception, because there each
 * request is its own conversation. `threadsAllowed` is the one place that
 * says so on the client (the row's thread menu, the composer, the store).
 */

/** Whether a conversation can carry reply threads: a room, or the viewer's chat with Homeroom bot. */
export function threadsAllowed(conversation: { kind?: string; homeroomBot?: boolean } | null | undefined): boolean {
  if (!conversation) return false;
  return conversation.kind !== 'direct' || conversation.homeroomBot === true;
}

/** A thread reply the bot also lists in the main chat: one of the four moments that ring. */
export function alsoInChat(message: { threadRootId?: number | null; metadata?: { homeroomBot?: { alsoInChat?: boolean } | null } | null }): boolean {
  return !!message.threadRootId && message.metadata?.homeroomBot?.alsoInChat === true;
}

/**
 * Whether a message is a position in the main stream, as the server counts
 * unread and moves the read cursor: a message of the conversation itself, or
 * a thread reply it also lists there (`alsoInChat`).
 */
export function inMainStream(message: { threadRootId?: number | null; metadata?: { homeroomBot?: { alsoInChat?: boolean } | null } | null }): boolean {
  return !message.threadRootId || alsoInChat(message);
}

/** What a request's thread is called, from any of its messages' metadata. */
export interface BotRequestNames {
  /** The project's name (or the stand-in for one nobody can name). */
  project: string;
  /** The request's own title, when it has one; null for a first version. */
  title: string | null;
  /** Its number on the project's board, when known. */
  number: number | null;
  firstVersion: boolean;
}

type RequestMeta = Pick<HomeroomBotMeta, 'appName' | 'appSlug' | 'issueNumber' | 'issueTitle' | 'firstVersion' | 'requestTitle'>;

/** Pure: the names a request's thread goes by, from a bot message's metadata. */
export function botRequestNames(meta: RequestMeta | null | undefined): BotRequestNames {
  const project = meta?.appName || meta?.appSlug || t('messages:bot.job.unnamedProject');
  const firstVersion = !!meta?.firstVersion;
  const title = firstVersion ? null : (meta?.requestTitle || meta?.issueTitle || null);
  const number = meta?.issueNumber && meta.issueNumber > 0 ? meta.issueNumber : null;
  return { project, title, number, firstVersion };
}

/** "Dark mode", "Plant Pal first version", "Request #12": a request's thread by its own name. */
export function botThreadTitle(names: BotRequestNames): string {
  if (names.firstVersion) return t('messages:bot.job.firstVersion', { project: names.project });
  if (names.title) return names.title;
  return names.number ? t('messages:bot.activity.requestNumber', { number: String(names.number) }) : names.project;
}

/** "↳ in Dark mode · Plant Pal": the label over a moment the main chat also shows. */
export function botThreadLabel(names: BotRequestNames): string {
  if (names.firstVersion) return t('messages:row.botThread.inFirstVersion', { project: names.project });
  if (names.title) return t('messages:row.botThread.in', { request: names.title, project: names.project });
  if (names.number) return t('messages:row.botThread.inNumbered', { number: String(names.number), project: names.project });
  return t('messages:row.botThread.inProject', { project: names.project });
}

/** public/js/app.js dispatches this on `homeroom_bot_work_changed` and on a socket reconnect. */
export const WORK_CHANGED_EVENT = 'homeroom-bot-work-changed';

/**
 * #4227: the endings that are still moving, drawn with the working card's
 * spinner (./bot-activity.tsx) and read again like work that is going: a
 * change being checked before it is offered, and one going live.
 */
export const SPINNING_OUTCOMES: ReadonlySet<HomeroomBotActivityOutcome> = new Set(['checking', 'going_live']);

/**
 * `appUnnamed`: `appName` is the stand-in for a project nobody can name. The
 * names below then use their unnamed wording, and never take the stand-in as
 * a project's name.
 */
type Named = Pick<HomeroomBotJob, 'appName' | 'appUnnamed' | 'issueNumber' | 'title' | 'firstVersion'>;

/** "Ear Trainer first version", "Ear Trainer #12": what the header's status line names. */
export function jobName(job: Named): string {
  if (job.appUnnamed) {
    if (job.firstVersion) return t('messages:bot.job.firstVersionUnnamed');
    return job.issueNumber ? t('messages:bot.job.requestUnnamed', { number: job.issueNumber }) : job.appName;
  }
  if (job.firstVersion) return t('messages:bot.job.firstVersion', { project: job.appName });
  return job.issueNumber ? t('messages:bot.job.request', { project: job.appName, number: job.issueNumber }) : job.appName;
}

/**
 * Short independent facts on one status line ("Building · 5m so far"). Each
 * part is a whole message already; what joins two of them is a message too.
 */
export function dotText(parts: readonly (string | null | undefined | false)[]): string {
  const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  if (!said.length) return '';
  return said.reduce((first, second) => t('messages:list.dot', { first, second }));
}

/** A tile's or a card's title: the name, and the request's own title when it has one. */
export function jobTitle(job: Named): string {
  if (job.firstVersion || !job.title) return jobName(job);
  if (job.appUnnamed) {
    return job.issueNumber
      ? t('messages:bot.job.requestTitledUnnamed', { number: job.issueNumber, title: job.title })
      : t('messages:bot.job.titledUnnamed', { title: job.title });
  }
  return job.issueNumber
    ? t('messages:bot.job.requestTitled', { project: job.appName, number: job.issueNumber, title: job.title })
    : t('messages:bot.job.titled', { project: job.appName, title: job.title });
}

/**
 * The project an in-app address opens on its App tab (`#app/<slug>/app`, as
 * services/homeroom-bot-dm.js openAppAction writes it), or null for any
 * other address.
 */
export function appTabSlug(target: string | null | undefined): string | null {
  const match = /^#app\/([^/?#]+)\/app$/.exec(String(target || ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

/**
 * #4231: the project whose community page an in-app address opens
 * (`#app/<slug>/workshop`, as services/homeroom-bot-dm.js firstLiveActions
 * writes it), or null for any other address.
 */
export function hubSlug(target: string | null | undefined): string | null {
  const match = /^#app\/([^/?#]+)\/workshop$/.exec(String(target || ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

/**
 * A bot button's way into the platform (`open`, always `#app/…`). A
 * project's App tab opens the way the rest of the shell opens a project's
 * app: App.openAppTab, as an app's icon and its about pane do, which also
 * works when that address is already the one in the bar. A community page
 * is a door that says where it goes, so it lands on the hub, not the tab the
 * page was last left on (AppView._landOnHub, as channel-hub.ts does). Any
 * other address, or no router, goes to the address.
 */
export function openAppTarget(target: string | null | undefined): void {
  if (typeof window === 'undefined' || !target || !target.startsWith('#app/')) return;
  const slug = appTabSlug(target);
  if (slug && typeof window.App?.openAppTab === 'function') {
    window.App.openAppTab(slug, 'app');
    return;
  }
  const hub = hubSlug(target);
  if (hub) {
    const view = (window as unknown as { AppView?: { _landOnHub?: (slug: string) => void } }).AppView;
    try { view?._landOnHub?.(hub); } catch { /* the page opens where it opens */ }
  }
  window.location.hash = target;
}

/*
 * ── The change a bot message is about (#4564) ──────────────────────────
 * In the chat with Homeroom bot, everything it says about one change is
 * drawn as one outlined block led by that change's card (./index.tsx
 * changeBlocks, ./message-row.tsx). What groups a message is the request it
 * already says it is about — its metadata's project and request number —
 * never the words. The same key orders a first version's plans
 * (./bot-plan.tsx planLayout), so the two readings cannot disagree.
 */

/**
 * Pure: which change a bot message is about, as "app#number", or null for
 * anything that is not the bot's own live message about one request: a
 * person's message, a deleted one, one still sending, or bot words about
 * the project alone (no request number). A first version carries request
 * number 1 under its own project, so its messages group by project, as
 * planLayout has always read them.
 */
export function changeKey(message: ConversationMessage): string | null {
  if (!message.sender.bot || message.deleted || !(message.id > 0)) return null;
  const meta = message.metadata?.homeroomBot;
  if (!meta || typeof meta !== 'object') return null;
  const n = Number(meta.issueNumber);
  if (!Number.isInteger(n) || n <= 0) return null;
  const app = meta.appSlug || meta.appName;
  return app ? `${app}#${n}` : null;
}

/**
 * Whether a message belongs to a reply thread: a reply in one, or the root
 * one hangs off. Its thread says which request it is about (#4564 retired
 * for these, changeBlocks).
 */
export function threaded(message: ConversationMessage): boolean {
  return !!message.threadRootId || !!message.thread;
}

/** How a row is drawn inside its change's block: alone, or where it sits in the run. */
export type ChangeBlockPart = 'only' | 'first' | 'middle' | 'last';

/** One drawn row's part of its change's block (#4564, ./message-row.tsx). */
export interface ChangeBlock {
  /** The change the block is about, as `changeKey` spells it. */
  key: string;
  /** Where the row sits: alone, opening, continuing or closing the block. */
  part: ChangeBlockPart;
  /**
   * An earlier row of the same block already shows the request (its card, its
   * activity card or a ready card naming it), so this row's own request card
   * is left out and its words carry a spoken label instead.
   */
  repeat: boolean;
}

export interface ChangeBlocksOptions {
  /**
   * The rows the transcript loop skips (a card Build it moved, a card whose
   * step its plan carries): passed over without breaking a run.
   */
  hidden: (message: ConversationMessage) => boolean;
  /**
   * Whether two adjacent drawn messages still share a stretch of transcript:
   * the loop passes same day and no unread line between them. Anything else
   * — a day divider, the "New" line — ends the block.
   */
  together: (previous: ConversationMessage, next: ConversationMessage) => boolean;
  /**
   * Whether a row itself shows the request's card, so a later row of the
   * same block may drop its own.
   */
  showsRequest: (message: ConversationMessage) => boolean;
}

/**
 * Pure: how the transcript `messages` draws its bot rows as change blocks,
 * by message id, for the rows it groups. Messages keep their order and are
 * grouped only where they are already adjacent: a run continues while each
 * next drawn message is the bot's message about the same request
 * (`changeKey`), is not threaded (`threaded`) and `together` still holds;
 * a day divider, the "New" line, a reply, anything someone else says and a
 * bot message about another change each end it. A message with no key —
 * those and a hidden one — is not in the map.
 *
 * `repeat` is true on a row when an earlier row of its run `showsRequest`:
 * its request card would say for a second time what the top of the block
 * already shows. The keyless and the threaded rows end a run; they never
 * carry one.
 *
 * RETIRED FOR THREADS (one request, one story). A request's story is its
 * thread now: its card is the thread's root, and what the bot says about it
 * is in that thread, so a threaded row (a reply, or a root with replies)
 * needs no outline to say which request it belongs to. Blocks still draw
 * the chat's history from before threads, where nothing is threaded.
 */
export function changeBlocks(
  messages: readonly ConversationMessage[],
  { hidden, together, showsRequest }: ChangeBlocksOptions,
): Map<number, ChangeBlock> {
  const blocks = new Map<number, ChangeBlock>();
  let run: ConversationMessage[] = [];
  const close = () => {
    if (!run.length) return;
    const key = changeKey(run[0]) as string;
    // Who shows the request, in order: a later row repeats when one before it does.
    const showing = run.map(showsRequest);
    const firstShow = showing.indexOf(true);
    run.forEach((message, index) => {
      blocks.set(message.id, {
        key,
        part: run.length === 1 ? 'only' : index === 0 ? 'first' : index === run.length - 1 ? 'last' : 'middle',
        repeat: firstShow >= 0 && firstShow < index,
      });
    });
    run = [];
  };
  for (const message of messages) {
    if (hidden(message)) continue;
    const key = changeKey(message);
    const previous = run[run.length - 1];
    const blocked = !!key && !threaded(message);
    const joins = blocked && !!previous && changeKey(previous) === key && together(previous, message);
    if (!joins) close();
    if (blocked) run.push(message);
  }
  close();
  return blocks;
}
