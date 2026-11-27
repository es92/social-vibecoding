/**
 * The new Needs you review flow's data, as plain functions (no React, no DOM),
 * so the pictures' crops and the feed's order can be tested on their own.
 *
 * Its rows are the Communities tab's own feed (GET /api/workshop/needs-feed,
 * ../workshop/needs-reel.tsx `NeedsFeedItem`), and its pictures are the
 * change's before & after shots shaped the way every other feed shapes them
 * (`AppView._workshopVisuals`): screens, each a before and an after still of
 * the same viewport with the areas that differ. What each item says about
 * its change (its name, its summary, what this person's vote is) is the one
 * model of a change (../dev-board/card/change.ts `changeFromFeed`), the same
 * every other summary of it reads.
 */

// Type only: the reel imports the project screen, which imports this flow.
import type { NeedsFeedItem } from '../workshop/needs-reel';
import { changeFromFeed, cleanTitle, type ChangeModel } from '../dev-board/card/change';

export type Box = { x: number; y: number; w: number; h: number };
export type Region = {
  n: number;
  b: number[] | null;
  a: number[] | null;
  bMark?: number[] | null;
  aMark?: number[] | null;
};
export type ReviewScreen = {
  viewport: string;
  width: number;
  /** Image pixels per CSS pixel the stills were saved at (1 before density was recorded). */
  density?: number;
  /** Denser stills of parts of the after side, `rect` in CSS px of this screen. */
  closeups?: Closeup[];
  // `thumb` is the thumbnail copy's address (lib/shot-img.ts): the middle
  // layer a slot draws before the sharp picture, and what a tile loads.
  before: { url: string; height: number; srcSet?: string; placeholder?: string | null; thumb?: string | null };
  after: { url: string; height: number; srcSet?: string; placeholder?: string | null; thumb?: string | null };
  regions: Region[];
  /**
   * What each declared change on this screen is about: the element its shots
   * agent shot, on each side (services/shots-diff.js screensFor), numbered as
   * the regions are. Every framing below frames on these first; they are
   * never drawn as an outline of a change.
   */
  frames?: Frame[];
  /** The declared changes this screen shows, by number (1 is the first claim). */
  changes?: number[];
};
export type Frame = { n: number; b: number[] | null; a: number[] | null };
/** What a card's picture is drawn from, best first. */
export type Picture =
  /** The change's own before & after screens (the slider). */
  | { kind: 'shots' }
  /** An older change's single capture pair. */
  | { kind: 'pair' }
  /** A change nobody can see, or whose shots are not taken yet: its benefit, drawn. */
  | { kind: 'benefit'; benefit: BenefitKind; area: AreaKind; token: { before: string; after: string } | null }
  /** A group decision, drawn by its kind. */
  | { kind: 'decision'; decision: DecisionKind };

export type BenefitKind = 'fixed' | 'stability' | 'clarity' | 'more' | 'results' | 'speed' | 'effort' | 'security' | 'behind';
export type DecisionKind = 'close_issue' | 'rename' | 'secret_change' | 'decision';
export type AreaKind = 'agents' | 'proposals' | 'platform' | 'projects' | 'accounts' | 'admin' | 'messages' | 'challenges' | 'app';

/**
 * A change or a group decision as the flow draws it: the one model of a
 * change (../dev-board/card/change.ts: its name, summary, epoch and what this
 * person's vote is), with its pictures and its lines.
 */
export interface ReviewItem extends ChangeModel {
  key: string;
  stagingUrl: string | null;
  /** The screens to compare, phone screens first when there are any. */
  screens: ReviewScreen[];
  /** An older change's single capture pair, with no regions. */
  pair: { before: string | null; after: string | null } | null;
  ground: string;
  /** The title shot's own still: the shots run's focus crop of the first change, when it has one. */
  titleImage: { url: string; width: number; height: number } | null;
  /** What the card and the hero draw. */
  picture: Picture;
  /** The change in one short line, under its picture on its page. */
  line: string;
  /** Each declared change in one short line, by number less one: an opened screen's line. */
  claims: string[];
  /**
   * #6439: on a group decision that is a vote to close a request, the
   * request's number: the page its vote is read and decided on. Null for
   * every other item.
   */
  request: number | null;
}

/**
 * The ground under a change's picture: how much it changes, said in colour.
 * Calm cream for one spot, warm yellow for a few, coral for a lot. The same
 * three grounds the title shots were designed with.
 */
export const GROUNDS = { quiet: '#ECE6CE', notable: '#F7E07A', loud: '#F2958A' } as const;

/**
 * Phone review #65 (23 Nov 2026): in dark, a screenshot does not sit in a
 * cream panel. The calm cream was the brightest thing on a near-black card,
 * framing a dark screenshot, so a picture of screens on the quiet ground
 * takes the card's raised dark ground instead. The warm and coral grounds
 * are a coloured stage that says how much changes, and a drawn picture was
 * designed on its ground, so both keep theirs.
 */
export const DARK_QUIET_GROUND = 'var(--rf-fill)';

export function groundInMode<T extends { ground: string; picture: Picture }>(item: T, dark: boolean): T {
  if (!dark || item.ground !== GROUNDS.quiet || item.picture.kind === 'benefit' || item.picture.kind === 'decision') return item;
  return { ...item, ground: DARK_QUIET_GROUND };
}

export function groundFor(screens: ReviewScreen[]): string {
  const spots = screens.reduce((n, s) => n + s.regions.length, 0);
  if (screens.length > 1 || spots >= 4) return GROUNDS.loud;
  if (spots >= 2) return GROUNDS.notable;
  return GROUNDS.quiet;
}

/**
 * The ground under a drawn picture: the colours the benefit cards were
 * designed on, so a list of them is not one long beige wall.
 */
const DRAWN_GROUNDS: Record<BenefitKind | 'decision', string> = {
  fixed: GROUNDS.notable, stability: GROUNDS.notable, clarity: GROUNDS.notable, more: GROUNDS.notable,
  speed: GROUNDS.notable, results: GROUNDS.quiet, effort: GROUNDS.quiet, security: GROUNDS.loud,
  behind: GROUNDS.quiet, decision: GROUNDS.quiet,
};

const BENEFITS: readonly BenefitKind[] = ['fixed', 'stability', 'clarity', 'more', 'results', 'speed', 'effort', 'security', 'behind'];
const AREAS: readonly AreaKind[] = ['agents', 'proposals', 'platform', 'projects', 'accounts', 'admin', 'messages', 'challenges', 'app'];

/** The Homeroom platform's own project: its areas are named; any other project's are "app". */
export const PLATFORM_SLUG = 'usernode-2d5619';

/**
 * Which benefit a change brings, from its words, for a change that declared
 * none (every change from before benefits were declared). The rules follow
 * the research's definitions: Fixed failed every time, Stability failed
 * sometimes; work no member would notice is Behind the scenes. First match
 * wins, so the narrower words come first.
 */
export function guessBenefit(title: string, summary = ''): BenefitKind {
  // The title says what the change is. The summary is read only to spot work
  // nobody would notice ("Nothing in the game changes"), which titles rarely say.
  const fromTitle = benefitRules(title);
  if (fromTitle) return fromTitle;
  const t = ` ${String(summary || '').toLowerCase()} `;
  if (/\bnothing (in the [a-z]+ |people see |)changes\b|\blooks the same\b|\bnothing changes in how\b/.test(t)) return 'behind';
  return 'more';
}

function benefitRules(text: string): BenefitKind | null {
  const t = ` ${String(text || '').toLowerCase()} `;
  const has = (re: RegExp) => re.test(t);
  const starts = (re: RegExp) => re.test(t.trimStart());
  if (has(/\b(tests?|test suite|mock timers?|refactor|lint|typecheck|readme|licen[cs]e|dependenc|upgrade|bump|cleanup|clean up|telemetry)\b/)) return 'behind';
  if (starts(/^(explain|say|says|name|label|word|tell|clarify)\b/)) return 'clarity';
  if (has(/\b(secur|privacy|private|secret|token|permission|leak|trackers|tracking|analytics|password|encrypt|redact|consent)/)) return 'security';
  if (has(/\b(faster|speed up|slow|load less|loads less|lighter|cache|latency|performance|quicker|instant)/)) return 'speed';
  if (has(/\b(crash|crashes|restart|retries|flaky|stall|stuck|hang|timeout|time out|race|intermittent|reliab|recover|survive)\b/)) return 'stability';
  if (has(/\b(fix|fixes|fixed|bug|broken|fails?|failed|failing|wrong|missing|missed|no longer|stop|stops)\b/)) return 'fixed';
  if (has(/\b(one tap|one-tap|fewer|less work|automatic|automatically|shortcut|skip|repeat|remember|quick)\b/)) return 'effort';
  if (has(/\b(clear|clearer|explain|explains|wording|rename|plainly|error|errors|validation|hint)\b/)) return 'clarity';
  if (has(/\b(better|improve|quality|accurate|smarter|ranking|polish|calmer|cleaner|nicer|redesign)/)) return 'results';
  if (starts(/^(add|show|let|lets|give|new|make|allow|support|enable|create|bring)\b/)) return 'more';
  return null;
}

/** Where a change is felt: a Homeroom area, or the project's own app. */
export function guessArea(text: string, slug: string): AreaKind {
  if (slug && slug !== PLATFORM_SLUG) return 'app';
  const t = ` ${String(text || '').toLowerCase()} `;
  const has = (re: RegExp) => re.test(t);
  if (has(/\b(admin)/)) return 'admin';
  if (has(/\b(challenge|season|points|leaderboard)/)) return 'challenges';
  if (has(/\b(agent|mayor|bot|worker|claude|codex|dev chat|dev-chat|session)/)) return 'agents';
  if (has(/\b(proposal|vote|voting|merge|change page|shots|checks?|preview|staging|request)/)) return 'proposals';
  if (has(/\b(message|chat|channel|discussion|thread|notification|inbox|dm)/)) return 'messages';
  if (has(/\b(sign in|sign-in|signin|account|password|email|profile|invite|wallet|log in)/)) return 'accounts';
  if (has(/\b(project|community|communities|workshop|hub|app page|discover)/)) return 'projects';
  return 'platform';
}

/**
 * The change in one short line: its first declared change (written as one
 * sentence for exactly this), else the first sentence of its summary, cut at
 * a word so it never becomes a wall of text. The full summary stays in About.
 */
export function changeLine(claim: string | null | undefined, summary: string | null | undefined, max = 140): string {
  const pick = String(claim || '').trim() || firstSentence(String(summary || ''));
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function firstSentence(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
    // A summary written under headings starts with the heading's words.
    .replace(/^(what changes( for people)?|what this changes|what it does|summary|tl;?dr|overview)\s*[:.\-]?\s+/i, '');
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).trim();
}

/** A phone screen when there is one: this flow is drawn for the phone first. */
export function pickScreens(screens: ReviewScreen[]): ReviewScreen[] {
  const phone = screens.filter((s) => s.viewport === 'mobile' || s.width < 500);
  return phone.length ? phone : screens;
}

type Visuals = {
  screens?: ReviewScreen[];
  before?: string | null;
  after?: string | null;
  protected?: boolean;
} | null;

/** A legacy pair's id is served from /visuals/<id>; a shots url is already a path. */
function pairUrl(value: string | null | undefined, isProtected: boolean): string | null {
  if (!value) return null;
  return isProtected || value.startsWith('/') ? value : `/visuals/${value}`;
}

/**
 * #6439: the request a group decision would close, when it is a vote to
 * close one (routes/workshop-overview.js `decisionFacts`). The request's
 * page is where that vote is read and decided; null for every other item.
 */
export function closeRequestOf(item: NeedsFeedItem): number | null {
  const decision = item.decision as { kind?: string; issueNumber?: number } | undefined;
  const n = decision && decision.kind === 'close_issue' ? Number(decision.issueNumber) : 0;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The feed's items as the flow draws them. `shape` is
 * `AppView._workshopVisuals` (passed in so this stays testable).
 */
export function toReviewItems(
  items: NeedsFeedItem[],
  shape: (visuals: unknown, shots: unknown) => Visuals,
): ReviewItem[] {
  // #6019: a ballot and the bot's question are decided on their request's
  // page; this flow draws the changes and decisions it knows. #6389: a
  // change waiting on its author's fix has nothing to vote on, so it is
  // left out of this flow too.
  return items
    .filter((item) => !(item.waitingOn && item.waitingOn.length))
    .filter((item) => item.kind === 'proposal' || item.kind === 'governance').map((item) => {
    const change = item.kind !== 'governance';
    const v = change && (item.shots || item.visuals) ? shape(item.visuals || null, item.shots || null) : null;
    const screens = pickScreens(Array.isArray(v?.screens) ? v!.screens! : []);
    const pair = !screens.length && v && (v.before || v.after)
      ? { before: pairUrl(v.before, !!v.protected), after: pairUrl(v.after, !!v.protected) }
      : null;
    const raw = item as NeedsFeedItem & { staging_url?: string | null };
    const shots = (item.shots && typeof item.shots === 'object' ? item.shots : {}) as {
      claims?: Array<{ claim?: string }>;
      artifacts?: Array<{ url?: string; width?: number; height?: number }>;
      impact?: string;
      benefit?: { kind?: string; area?: string; before?: string; after?: string } | null;
    };
    const claim = Array.isArray(shots.claims) && shots.claims[0] ? shots.claims[0].claim || '' : '';
    const facts = changeFromFeed(item);
    const { summary } = facts;
    const words = `${item.title || ''} ${summary}`;
    // The title shot's own still: the run's crop of the first change (the
    // shaped `after`), sized from its artifact so the plate keeps its shape.
    const afterUrl = v && typeof v.after === 'string' ? v.after : null;
    const art = afterUrl && Array.isArray(shots.artifacts) ? shots.artifacts.find((a) => a && a.url === afterUrl) : null;
    const titleImage = afterUrl && art && Number(art.width) > 0 && Number(art.height) > 0
      ? { url: afterUrl, width: Number(art.width), height: Number(art.height) }
      : null;
    let picture: Picture;
    if (!change) {
      const k = (item.decision as { kind?: string } | undefined)?.kind;
      picture = { kind: 'decision', decision: k === 'close_issue' || k === 'rename' || k === 'secret_change' ? k : 'decision' };
    } else if (screens.length) picture = { kind: 'shots' };
    else if (pair) picture = { kind: 'pair' };
    else {
      // A declared benefit (visible-changes `benefit`, on the feed row and in
      // its shots) wins over the guess; history has none, so it is guessed.
      const raw2 = (item as unknown as { benefit?: typeof shots.benefit }).benefit || shots.benefit;
      const declared = raw2 && BENEFITS.includes(raw2.kind as BenefitKind) ? raw2 : null;
      const area = declared && AREAS.includes(declared.area as AreaKind) ? declared.area as AreaKind : guessArea(words, item.app?.slug || '');
      picture = {
        kind: 'benefit',
        benefit: declared ? declared.kind as BenefitKind : guessBenefit(item.title || '', summary),
        area,
        token: declared && declared.before && declared.after ? { before: String(declared.before), after: String(declared.after) } : null,
      };
    }
    const ground = picture.kind === 'benefit' ? DRAWN_GROUNDS[picture.benefit]
      : picture.kind === 'decision' ? DRAWN_GROUNDS.decision
      : groundFor(screens);
    return {
      ...facts,
      key: `${facts.kind}:${item.id}`,
      stagingUrl: typeof raw.staging_url === 'string' && raw.staging_url ? raw.staging_url : null,
      screens,
      pair,
      ground,
      titleImage,
      picture,
      line: changeLine(claim, summary),
      claims: (Array.isArray(shots.claims) ? shots.claims : []).map((c) => changeLine(c && c.claim, '')),
      request: closeRequestOf(item),
    };
  });
}

/**
 * The feed's items the run cannot draw: a group decision, competing changes
 * for one request, and a question Homeroom bot asked. Each is decided on its
 * own page, so Needs you lists them with a way there instead of skipping them
 * (#6344). `t` is the caller's translator, so this stays pure.
 */
export type PageKind = 'governance' | 'ballot' | 'question';

export type PageItem = {
  key: string;
  kind: PageKind;
  id: number;
  /** The item's own title, or the fallback sentence the feed already uses. */
  title: string;
  app: NeedsFeedItem['app'];
  href: string;
};

export function pageItems(
  items: NeedsFeedItem[],
  t: (id: string, values?: Record<string, string | number>) => string,
): PageItem[] {
  const out: PageItem[] = [];
  for (const item of items) {
    const kind = item.kind;
    if (kind !== 'governance' && kind !== 'ballot' && kind !== 'question') continue;
    const slug = item.app?.slug;
    // An item with no project has no page to open.
    if (!slug) continue;
    const app = encodeURIComponent(slug);
    const ballot = kind === 'ballot' ? item.ballot : null;
    const number = ballot ? (ballot.number ?? item.number) : item.number;
    const own = kind === 'ballot' ? ballot?.title : item.title;
    const title = cleanTitle(own || '')
      || (kind === 'governance' ? t('communities:reel.fallbackTitle.decision')
        : kind === 'ballot' ? t('communities:reel.ballot.fallbackTitle', { number: number ?? '' })
        : t('communities:reel.fallbackTitle.question'));
    // A group decision has its own page; competing changes and the bot's
    // question are decided on their request's. With no request, the Workshop.
    // #6439: a vote to close a request opens the request's page, where the
    // vote already draws; every other decision keeps its own page.
    const closing = kind === 'governance' ? closeRequestOf(item) : null;
    const href = kind === 'governance'
      ? (closing ? `#app/${app}/dev/issues/${closing}` : `#app/${app}/dev/governance/${Number(item.id)}`)
      : number ? `#app/${app}/dev/issues/${Number(number)}` : `#app/${app}/workshop`;
    out.push({ key: `${kind}:${item.id}`, kind, id: item.id, title, app: item.app, href });
  }
  return out;
}

/** A region's box on one side, or a mark line's box (zero height). */
export function regionBox(r: Region, side: 'before' | 'after'): Box | null {
  const box = side === 'before' ? r.b : r.a;
  if (box && box.length === 4) return { x: box[0], y: box[1], w: box[2], h: box[3] };
  const mark = side === 'before' ? r.bMark : r.aMark;
  if (mark && mark.length === 3) return { x: mark[0], y: mark[1], w: mark[2], h: 0 };
  return null;
}

/**
 * A region that only moved: the same size on both sides, somewhere else. A
 * row pushed down by the change is marked as a region too, but it is not
 * what the change does, so pictures never frame or crop round it.
 */
export function onlyMoved(r: Region): boolean {
  if (!r.b || !r.a || r.b.length !== 4 || r.a.length !== 4) return false;
  const same = Math.abs(r.b[2] - r.a[2]) <= 2 && Math.abs(r.b[3] - r.a[3]) <= 2;
  return same && (Math.abs(r.b[0] - r.a[0]) >= 2 || Math.abs(r.b[1] - r.a[1]) >= 2);
}

/**
 * Where a region is on the after screen: its after box, or, for a part the
 * change took away (the after side keeps only a mark line), the box it had
 * before, which is where it was.
 */
export function afterBox(r: Region): Box | null {
  const a = regionBox(r, 'after');
  if (a && a.h > 0) return a;
  const b = regionBox(r, 'before');
  return b && b.h > 0 ? b : a;
}

/** The regions that say what changed: the declared ones when there are any, and never one that only moved. */
export function changedRegions(screen: ReviewScreen): Region[] {
  const moved = screen.regions.filter((r) => !onlyMoved(r));
  const real = moved.length ? moved : screen.regions;
  const named = real.filter((r) => r.n > 0);
  return named.length ? named : real;
}

/**
 * Each declared change's frame on one side of a screen: the element it is
 * about. A frame with only the other side (nothing there before, say)
 * stands for this one, where the change appears.
 */
export function frameBoxes(screen: ReviewScreen, side: 'before' | 'after'): Box[] {
  const of = (v: number[] | null | undefined): Box | null => (v && v.length === 4 && v[2] > 0 && v[3] > 0
    ? { x: v[0], y: v[1], w: v[2], h: v[3] } : null);
  return (screen.frames || []).filter((f) => f && f.n > 0)
    .map((f) => of(side === 'before' ? f.b : f.a) || of(side === 'before' ? f.a : f.b))
    .filter((b): b is Box => !!b);
}

/** The screen's declared changes' frames on the given sides, as one box; null when it has none. */
export function frameBox(screen: ReviewScreen, sides: Array<'before' | 'after'>): Box | null {
  const boxes = sides.flatMap((s) => frameBoxes(screen, s));
  return boxes.length ? boxes.reduce(union2) : null;
}

/**
 * Where a picture of the screen frames, on the given sides, with room
 * around it, kept on the screen. Best first: the frame of the change the
 * screen shows (the element it is about), the declared areas, any area that
 * differs, the screen's top.
 */
export function focusBox(screen: ReviewScreen, sides: Array<'before' | 'after'>, pad: number): Box {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const frame = frameBox(screen, sides);
  const boxes = frame ? [frame]
    : changedRegions(screen).flatMap((r) => sides.map((s) => regionBox(r, s))).filter((b): b is Box => !!b);
  if (!boxes.length) return { x: 0, y: 0, w: W, h: Math.min(H, W * 0.75) };
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.w)) + pad);
  const y1 = Math.min(H, Math.max(...boxes.map((b) => b.y + Math.max(b.h, 2))) + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export type Placement = { scale: number; tx: number; ty: number };

/**
 * Where the whole screen goes so `box` sits in the middle of a `view`, as
 * large as fits but never past `maxScale`, without showing past the screen's
 * edges when the screen is larger than the view. ONE placement for both
 * sides, so a seam between them never moves what it compares.
 */
export function placeBox(
  screen: ReviewScreen, box: Box, view: { w: number; h: number }, maxScale = 1,
): Placement {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const scale = Math.max(0.05, Math.min(maxScale, view.w / box.w, view.h / box.h));
  const sw = W * scale;
  const sh = H * scale;
  const centre = (size: number, scaled: number, mid: number) => (scaled <= size
    ? (size - scaled) / 2
    : Math.max(size - scaled, Math.min(0, size / 2 - mid * scale)));
  return { scale, tx: centre(view.w, sw, box.x + box.w / 2), ty: centre(view.h, sh, box.y + box.h / 2) };
}

/**
 * The title shot: the after side's changed area, as a plate sized to its own
 * proportions inside the card's room (at most `room.w` by `room.h`).
 * Returns the plate's size and where the screen sits inside it.
 */
export function titleCrop(screen: ReviewScreen, room: { w: number; h: number }): { w: number; h: number; place: Placement } {
  // What the change is about (its frame), else the biggest declared thing
  // that changed, with room around it: a union of every change on a busy
  // screen came out as the whole screen, shrunk.
  const big = frameBox(screen, ['after']) || largestRegion({ ...screen, regions: changedRegions(screen) });
  const W = screen.width;
  const H = screen.after.height;
  const pad = 24;
  const box = big
    ? (() => {
      const x0 = Math.max(0, big.x - pad);
      const y0 = Math.max(0, big.y - pad);
      const x1 = Math.min(W, big.x + big.w + pad);
      const y1 = Math.min(H, big.y + Math.max(big.h, 2) + pad);
      return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    })()
    : focusBox(screen, ['after'], 20);
  const k = Math.min(2, room.w / box.w, room.h / box.h);
  const w = Math.round(box.w * k);
  const h = Math.round(box.h * k);
  return { w, h, place: { scale: k, tx: -box.x * k, ty: -box.y * k } };
}

/* ── The seam's feel ───────────────────────────────────────────────────── */

/**
 * iOS-style resistance past an edge: the further the finger goes, the less
 * the seam follows. `c` is the rubber band's stiffness (0.55 feels like iOS).
 */
export function rubberBand(overshoot: number, width: number, c = 0.55): number {
  const d = Math.abs(overshoot);
  const out = (1 - 1 / ((d * c) / width + 1)) * width;
  return overshoot < 0 ? -out : out;
}

/**
 * Soft stops: near a stop the seam is pulled onto it, strongest at the stop
 * and gone by `radius`. Stops are the left and right edges of each changed
 * area (with a little room) and its middle.
 */
export function seamStops(screen: ReviewScreen, place: Placement, width: number): number[] {
  const stops: number[] = [];
  for (const r of screen.regions) {
    for (const side of ['before', 'after'] as const) {
      const b = regionBox(r, side);
      if (!b || b.w <= 0) continue;
      const x0 = b.x * place.scale + place.tx;
      const x1 = (b.x + b.w) * place.scale + place.tx;
      [x0 - 14, (x0 + x1) / 2, x1 + 14].forEach((x) => { if (x > 8 && x < width - 8) stops.push(x); });
    }
  }
  return stops.sort((a, b) => a - b);
}

export function magnet(x: number, stops: number[], radius = 18, strength = 0.8): number {
  let out = x;
  for (const p of stops) {
    const d = x - p;
    const u = Math.abs(d) / radius;
    if (u < 1) {
      const w = (1 - u * u) * (1 - u * u);
      out -= d * strength * w;
    }
  }
  return out;
}

/**
 * The feed's order: changes first, as they came, then group decisions. A run
 * of "Close issue" decisions at the top once buried every change under them.
 */
export function orderForReview(items: ReviewItem[]): ReviewItem[] {
  return [...items.filter((i) => i.kind !== 'governance'), ...items.filter((i) => i.kind === 'governance')];
}

/**
 * Pure: a run with what a later read of the feed added, at its end. The run
 * itself never moves: what it holds keeps its place and its own copy, so the
 * change on show, a vote and a skip stay where they are, and a change the
 * person already voted on or skipped is never added a second time (it is
 * still in the run, by its key). The same array back when the read holds
 * nothing new. A project's own Needs you grows this way when a vote opens
 * while the page is up (review-flow.tsx).
 */
export function growRun(run: ReviewItem[], read: ReviewItem[]): ReviewItem[] {
  const held = new Set(run.map((it) => it.key));
  const added = read.filter((it) => !held.has(it.key));
  return added.length ? [...run, ...added] : run;
}

/** Where a run stands when a later read lands (review-flow.tsx's own state). */
export interface RunStanding {
  list: ReviewItem[];
  /** The change on show, as an index into the run the vote-type chips leave. */
  index: number;
  /** The end is on show. */
  done: boolean;
  votes: Record<string, unknown>;
  skipped: Record<string, unknown>;
}

/**
 * Pure: what a later read of the feed does to a run that grows. `list` is the
 * run with what arrived at its end (growRun; the same array when nothing
 * did), and `open` is where the page opens, or null to leave it as it is:
 *
 *   - a change is on show: it stays, and the arrival is reached by Next;
 *   - nothing is on show (the empty line, the list of pages decided
 *     elsewhere, the end): the page opens on the first change that has no
 *     vote or skip from you, which is one that arrived. Changes skipped
 *     earlier keep their skip, and wait at the end as they did.
 *
 * `shown` is the run the vote-type chips leave (filterByVoteType); `index`
 * and `open` count in it.
 */
export function takeRead(
  run: RunStanding,
  read: ReviewItem[],
  shown: (list: ReviewItem[]) => ReviewItem[] = (list) => list,
): { list: ReviewItem[]; open: number | null } {
  const list = growRun(run.list, read);
  if (list === run.list) return { list, open: null };
  const here = shown(run.list)[run.index];
  if (!run.done && !!here && here.kind !== 'governance') return { list, open: null };
  const first = shown(list).findIndex((it) => it.kind !== 'governance' && !run.votes[it.key] && !run.skipped[it.key]);
  return { list, open: first >= 0 ? first : null };
}

/** The largest changed area on a screen's after side, for a title shot that zooms in on it. */
export function largestRegion(screen: ReviewScreen): Box | null {
  let best: Box | null = null;
  for (const r of screen.regions) {
    const b = regionBox(r, 'after') || regionBox(r, 'before');
    if (b && (!best || b.w * Math.max(b.h, 2) > best.w * Math.max(best.h, 2))) best = b;
  }
  return best;
}

/**
 * The next change after `index` that still has no vote, wrapping round once
 * to the ones behind you; -1 when every other one has a vote from you. Group
 * decisions are skipped: they open their own page and none is voted on here.
 */
export function nextIndex(items: ReviewItem[], index: number, votes: Record<string, unknown> = {}): number {
  for (let step = 1; step < items.length; step++) {
    const i = (index + step) % items.length;
    const it = items[i];
    if (!it || it.kind === 'governance' || votes[it.key]) continue;
    return i;
  }
  return -1;
}

/**
 * The change a trail of keys leads back to: `keys` is the run's changes in
 * the order they were shown, and the last of them that is still in `run`
 * (and is not a group decision) is the one. Returns its index in `run`, and
 * the keys that were not used, so going on again passes over what it
 * skipped. Nothing left gives -1.
 */
export function trailIndex(run: ReviewItem[], keys: string[]): { index: number; rest: string[] } {
  let rest = keys.slice();
  while (rest.length) {
    const key = rest[rest.length - 1];
    rest = rest.slice(0, -1);
    const i = run.findIndex((it) => it.key === key);
    if (i >= 0 && run[i].kind !== 'governance') return { index: i, rest };
  }
  return { index: -1, rest: [] };
}

/* ── The title shot's composition (the factory prototype's rules) ─────────
 *
 * Ported from the title-shots factory (research 2026-10-15/16), on what
 * production has: each screen's after still and the areas that differ on it.
 *
 * - ONE piece: its binding side takes 62% of the card, or its real size when
 *   that fits within 92% (never shrunk below real size when real size fits),
 *   centred across and at 48% down.
 * - TWO TO FOUR pieces: a grid at ONE common scale, each piece on its own
 *   plate; of stack, row, 2×2 and lead-left, the layout with the largest
 *   scale wins. Below 0.75× the grid becomes a DECK.
 * - MORE (or a grid that would be too small): a deck, like stacked
 *   notifications. The lead keeps the single rule; up to three plain plates
 *   peek 8px below it, each narrower and melted toward the ground.
 * - A piece is the lowest useful abstraction: the changed area with 16px of
 *   its real surroundings as its plate (flat, house radius, no shadow), never
 *   a thin strip (a strip gets real context above and below it), and never
 *   taller than the card can show (it is cut to a window from its top).
 * - Never pixelated: no piece is shown larger than the pixels captured for
 *   it (`density`, the still's pixels per point, over the display's). A
 *   piece inside a close-up (a denser still of that part of the after side)
 *   draws from the close-up, so a small change can be shown big and sharp.
 */

export type TitlePiece = { screen: ReviewScreen; box: Box };
export type Closeup = { url: string; rect: Box; density: number };
export type TitlePlate = {
  x: number; y: number; w: number; h: number; r: number;
  /** The still, placed so the piece shows inside the plate; null for a deck's back plate. */
  img: { url: string; srcSet?: string; sizes?: string; left: number; top: number; width: number; height: number } | null;
  /** A deck's back plate: one plain tone. */
  fill?: string;
  z: number;
};
export type TitleComposition = { rule: 'single' | 'grid' | 'deck'; plates: TitlePlate[] };

const COVER = { share: 0.62, wide: 0.92, pad: 16, centre: 0.48, minGrid: 0.75, peek: 8, inset: 0.03, radius: 16 };
const VEIL = [0.30, 0.55, 0.80];

function boxArea(b: Box): number { return b.w * Math.max(b.h, 2); }

function near(a: Box, b: Box, gap: number): boolean {
  return a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
}

function union2(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * What a change shows on a screen, as pieces: the areas that belong to a
 * declared change (the unnumbered ones are noise when numbered ones exist),
 * near ones merged, specks dropped, each widened into a readable unit.
 */
export function piecesOf(screens: ReviewScreen[], max = 6): TitlePiece[] {
  const out: TitlePiece[] = [];
  for (const screen of screens) {
    const H = screen.after.height;
    const W = screen.width;
    const kept = screen.regions.filter((r) => !onlyMoved(r));
    const all = (kept.length ? kept : screen.regions).map((r) => ({ r, b: afterBox(r) })).filter((x) => x.b && x.b.w > 2) as Array<{ r: Region; b: Box }>;
    const named = all.filter((x) => x.r.n > 0);
    // What each change is about (its frame) when the screen has one; else
    // its declared areas, else any.
    const framed = frameBoxes(screen, 'after').filter((b) => b.w > 2);
    let boxes = framed.length ? framed : (named.length ? named : all).map((x) => x.b);
    // Near areas are one piece; a speck beside a real change is not a piece.
    const merged: Box[] = [];
    for (const b of boxes.sort((p, q) => boxArea(q) - boxArea(p))) {
      const hit = merged.findIndex((m) => near(m, b, 24));
      if (hit >= 0) merged[hit] = union2(merged[hit], b);
      else merged.push(b);
    }
    const biggest = merged.length ? boxArea(merged[0]) : 0;
    boxes = merged.filter((b) => boxArea(b) >= biggest * 0.04);
    for (const b of boxes) {
      // Never a thin strip: a line of text gets the lines around it.
      let { x, y, w, h } = b;
      const minH = Math.min(H, Math.max(56, w / 3.2));
      if (h < minH) { y = Math.max(0, Math.min(H - minH, y - (minH - h) / 2)); h = minH; }
      out.push({ screen, box: { x: Math.max(0, x), y, w: Math.min(W - Math.max(0, x), w), h } });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * How large a piece's still may be shown, in points per point: its saved
 * pixels per point over the display's, so a zoom never stretches pixels the
 * capture does not have. Never below 1: today's 1x stills keep their size.
 */
export function densityOf(screen: ReviewScreen, display = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): number {
  const saved = Number(screen.density) >= 1 ? Number(screen.density) : 1;
  return Math.max(1, saved / display);
}

/** The close-up a piece's plate can draw from: one on its screen that holds the whole plate. */
export function closeupFor(p: TitlePiece, b: Box): Closeup | null {
  const fits = (r: Box) => r.x <= b.x + 1 && r.y <= b.y + 1 && r.x + r.w >= b.x + b.w - 1 && r.y + r.h >= b.y + b.h - 1;
  return (p.screen.closeups || []).find((c) => c.density > 1 && fits(c.rect)) || null;
}

/** How large a plate may be shown: its close-up's pixels when it has one, else the screen's. */
export function pieceDensity(p: TitlePiece, b: Box, display = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): number {
  const c = closeupFor(p, b);
  return Math.max(densityOf(p.screen, display), c ? c.density / display : 1);
}

function padded(p: TitlePiece): Box {
  const pad = COVER.pad; const { box, screen } = p;
  const x = Math.max(0, box.x - pad); const y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(screen.width, box.x + box.w + pad) - x, h: Math.min(screen.after.height, box.y + box.h + pad) - y };
}

/** A piece taller than the card can show at 0.75× is cut to a window from its top. */
function cut(b: Box, cap: number): Box {
  return b.h <= cap ? b : { x: b.x, y: b.y, w: b.w, h: cap };
}

function plateFor(p: TitlePiece, b: Box, s: number, cx: number, cy: number, z: number): TitlePlate {
  const w = b.w * s; const h = b.h * s;
  const x = cx - w / 2; const y = cy - h / 2;
  const c = closeupFor(p, b);
  return {
    x, y, w, h, r: Math.min(COVER.radius, h / 2), z,
    img: c
      ? { url: c.url, left: (c.rect.x - b.x) * s, top: (c.rect.y - b.y) * s, width: c.rect.w * s, height: c.rect.h * s }
      // The whole screen at its drawn width: the browser takes the smallest
      // copy sharp for it (the thumbnail at a sheet's usual sizes), not the
      // full PNG it used to load for every plate.
      : {
        url: p.screen.after.url,
        ...(p.screen.after.srcSet ? { srcSet: p.screen.after.srcSet, sizes: `${Math.max(1, Math.round(p.screen.width * s))}px` } : {}),
        left: -b.x * s, top: -b.y * s, width: p.screen.width * s, height: p.screen.after.height * s,
      },
  };
}

function singleScale(b: Box, card: { w: number; h: number }, density: number, maxS?: number): number {
  const framed = COVER.share * Math.min(card.w / b.w, card.h / b.h);
  const real = Math.min(1, COVER.wide * card.w / b.w, COVER.wide * card.h / b.h);
  let s = Math.max(framed, real);
  s = Math.min(s, density, COVER.wide * card.w / b.w, COVER.wide * card.h / b.h);
  return maxS ? Math.min(s, maxS) : s;
}

type Layout = { cells: Array<[number, number, number?]> ; name: string };
function layouts(n: number): Layout[] {
  const L: Layout[] = [{ name: 'stack', cells: [] }, { name: 'row', cells: [] }];
  for (let i = 0; i < n; i++) { L[0].cells.push([0, i]); L[1].cells.push([i, 0]); }
  if (n >= 3) {
    const q: Layout = { name: '2x2', cells: [] }; for (let i = 0; i < n; i++) q.cells.push([i % 2, Math.floor(i / 2)]); L.push(q);
    const ll: Layout = { name: 'lead-left', cells: [[0, 0, n - 1]] }; for (let i = 1; i < n; i++) ll.cells.push([1, i - 1]); L.push(ll);
  }
  return L;
}

function gridFit(boxes: Box[], lay: Layout, s: number) {
  const g = COVER.pad; const cols: number[] = []; const rows: number[] = [];
  boxes.forEach((b, i) => {
    const c = lay.cells[i]; if (c[2]) return;
    cols[c[0]] = Math.max(cols[c[0]] || 0, b.w * s); rows[c[1]] = Math.max(rows[c[1]] || 0, b.h * s);
  });
  if (lay.cells[0][2]) {
    cols[0] = boxes[0].w * s;
    const need = boxes[0].h * s; const have = rows.reduce((a, v) => a + (v || 0), 0) + (rows.length - 1) * g;
    if (need > have) rows[rows.length - 1] = (rows[rows.length - 1] || 0) + need - have;
  }
  for (let i = 0; i < cols.length; i++) cols[i] = cols[i] || 0;
  for (let i = 0; i < rows.length; i++) rows[i] = rows[i] || 0;
  return { W: cols.reduce((a, v) => a + v, 0) + (cols.length - 1) * g, H: rows.reduce((a, v) => a + v, 0) + (rows.length - 1) * g, cols, rows };
}

function mixHex(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const x = p(a); const y = p(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** The title shot: its plates on a card of `card` points, on `ground`. */
export function composeTitle(pieces: TitlePiece[], card: { w: number; h: number }, ground: string): TitleComposition | null {
  if (!pieces.length) return null;
  const cy = card.h * COVER.centre;
  const one = (p: TitlePiece, maxS?: number) => {
    const b = cut(padded(p), (COVER.wide * card.h) / 0.75);
    const s = singleScale(b, card, pieceDensity(p, b), maxS);
    return { b, s };
  };
  if (pieces.length === 1) {
    const { b, s } = one(pieces[0]);
    return { rule: 'single', plates: [plateFor(pieces[0], b, s, card.w / 2, cy, 10)] };
  }
  if (pieces.length <= 4) {
    const cap = ((COVER.wide * card.h - COVER.pad) / 2) / 0.75;
    const boxes = pieces.map((p) => cut(padded(p), cap));
    let best: { s: number; lay: Layout } | null = null;
    for (const lay of layouts(boxes.length)) {
      const f0 = gridFit(boxes, lay, 0); const f1 = gridFit(boxes, lay, 1);
      const aw = f1.W - f0.W; const ah = f1.H - f0.H;
      const framed = Math.min((COVER.share * card.w - f0.W) / aw, (COVER.share * card.h - f0.H) / ah);
      const real = Math.min(1, (COVER.wide * card.w - f0.W) / aw, (COVER.wide * card.h - f0.H) / ah);
      const fits = Math.min((COVER.wide * card.w - f0.W) / aw, (COVER.wide * card.h - f0.H) / ah);
      const dens = Math.min(...pieces.map((p, i) => pieceDensity(p, boxes[i])));
      const s = Math.min(Math.max(framed, real), fits, dens);
      if (!best || s > best.s + 1e-6) best = { s, lay };
    }
    if (best && best.s >= COVER.minGrid) {
      const { s, lay } = best; const fit = gridFit(boxes, lay, s); const g = COVER.pad;
      const x0 = (card.w - fit.W) / 2; const y0 = cy - fit.H / 2;
      const colX = [x0]; const rowY = [y0];
      for (let i = 1; i < fit.cols.length; i++) colX[i] = colX[i - 1] + fit.cols[i - 1] + g;
      for (let i = 1; i < fit.rows.length; i++) rowY[i] = rowY[i - 1] + fit.rows[i - 1] + g;
      return {
        rule: 'grid',
        plates: pieces.map((p, i) => {
          const c = lay.cells[i];
          let cx = colX[c[0]]; let cw = fit.cols[c[0]];
          if (lay.name === 'stack') { cw = fit.W; cx = x0; }
          const ch = c[2] ? fit.H : fit.rows[c[1]];
          return plateFor(p, boxes[i], s, cx + cw / 2, rowY[c[1]] + ch / 2, 10);
        }),
      };
    }
  }
  // The deck: the lead keeps the single rule, the stack stays inside the
  // wide allowance, and the back plates are plain tones peeking below.
  const n = Math.min(4, pieces.length);
  const lead = pieces[0];
  const lb = cut(padded(lead), (COVER.wide * card.h - (n - 1) * COVER.peek) / 0.75);
  const s = singleScale(lb, card, pieceDensity(lead, lb), (COVER.wide * card.h - (n - 1) * COVER.peek) / lb.h);
  const H = lb.h * s; const W = Math.max(lb.w * s, 0.66 * card.w);
  const top = cy - (H + (n - 1) * COVER.peek) / 2;
  const front = plateFor(lead, lb, s, card.w / 2, top + H / 2, 10);
  // The lead's plate takes the deck's width, its piece centred in it.
  const leadPlate: TitlePlate = { ...front, x: (card.w - W) / 2, w: W, img: front.img ? { ...front.img, left: front.img.left + (W - lb.w * s) / 2 } : null };
  const plates: TitlePlate[] = [leadPlate];
  for (let i = 1; i < n; i++) {
    const w = W * (1 - 2 * COVER.inset * i);
    plates.push({ x: (card.w - w) / 2, y: top + i * COVER.peek, w, h: H, r: leadPlate.r, img: null, fill: mixHex('#ffffff', ground, VEIL[i - 1]), z: 10 - i });
  }
  return { rule: 'deck', plates };
}

/* ── Where a crop may end ─────────────────────────────────────────────────
 *
 * A crop that ends through a line of text reads as a mistake: half a
 * heading, a word cut short. So every crop's edges move, a little, onto
 * rows (and, for a tile, a column) where the still is one flat colour.
 * `Ink` is the after still read once at one sample per screen point
 * (./ink.ts); without it the crops stay as computed.
 */

export type Ink = { w: number; h: number; lum: Uint8Array };

/** How much a row may vary and still count as blank (0 to 255). */
const FLAT = 10;

function rowFlat(ink: Ink, y: number, x0: number, x1: number): boolean {
  const r = Math.round(y);
  if (r <= 0 || r >= ink.h) return true;
  let lo = 255; let hi = 0;
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(ink.w, Math.ceil(x1)); x++) {
    const v = ink.lum[r * ink.w + x];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (hi - lo > FLAT) return false;
  }
  return true;
}

function colFlat(ink: Ink, x: number, y0: number, y1: number): boolean {
  const c = Math.round(x);
  if (c <= 0 || c >= ink.w) return true;
  let lo = 255; let hi = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(ink.h, Math.ceil(y1)); y++) {
    const v = ink.lum[y * ink.w + c];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (hi - lo > FLAT) return false;
  }
  return true;
}

/** Offsets 0, -1, 1, -2, 2 … to `reach`: the nearest first. */
function* nearest(reach: number): Generator<number> {
  yield 0;
  for (let d = 1; d <= reach; d++) { yield -d; yield d; }
}

/**
 * A crop with its top and bottom moved onto blank rows near them: never into
 * `keep` (the change) when the change fits, and never taller than `maxH`.
 */
export function snapRows(b: Box, ink: Ink | null | undefined, keep: Box | null, maxH: number, reach = 24): Box {
  if (!ink) return b;
  const fits = !!keep && keep.h + 4 <= maxH;
  const H = ink.h;
  for (const dt of nearest(reach)) {
    const top = b.y + dt;
    if (top < 0 || top > H) continue;
    if (fits && top > keep!.y) continue;
    if (!rowFlat(ink, top, b.x, b.x + b.w)) continue;
    for (const db of nearest(reach)) {
      const bottom = b.y + b.h + db;
      if (bottom > H || bottom - top > maxH || bottom - top < 24) continue;
      if (fits && bottom < keep!.y + keep!.h) continue;
      if (rowFlat(ink, bottom, b.x, b.x + b.w)) return { x: b.x, y: top, w: b.w, h: bottom - top };
    }
  }
  return b;
}

/* ── The sheet: every screen of a change at once ────────────────────────
 *
 * A change lands on its sheet: one plate per screen, each that screen's
 * main piece (its largest, widened the way the title shot widens it), all
 * at ONE scale on the change's ground. It is never a deck, so every screen
 * can be tapped: the plates stack when they are wide (a phone's rows), or
 * sit two to a row when they are narrow, whichever shows them larger. A
 * plate taller than its share is cut to a window round its change. A tap
 * opens that screen in place (review-flow.tsx), and the strip under the
 * picture holds the same screens as tiles.
 */

const SHEET = { wide: 0.92, gap: 16, centre: 0.5 };

export type SheetPlate = TitlePlate & {
  screen: number;
  /** The part of the screen the plate shows (screen points) and its scale: where an opening screen starts. */
  box: Box;
  s: number;
};

/** A screen's main piece: its largest, or the top of the screen when nothing is marked. */
export function mainPiece(screen: ReviewScreen): TitlePiece {
  if (onlySpeck(screen)) {
    return { screen, box: { x: 0, y: 0, w: screen.width, h: Math.min(screen.after.height, screen.width * 1.2) } };
  }
  const all = piecesOf([screen]);
  const best = all.reduce<TitlePiece | null>((a, p) => (!a || boxArea(p.box) > boxArea(a.box) ? p : a), null);
  return best || { screen, box: { x: 0, y: 0, w: screen.width, h: Math.min(screen.after.height, screen.width * 0.75) } };
}

/** A window `h` tall from `b`, starting `top` (16pt above its change) and kept inside `b`. */
function windowOf(b: Box, h: number, top: number): Box {
  if (b.h <= h) return b;
  const y = Math.max(b.y, Math.min(b.y + b.h - h, top));
  return { x: b.x, y, w: b.w, h };
}

/** The sheet for `screens` on a card of `card` points: one plate per screen. */
export function composeSheet(screens: ReviewScreen[], card: { w: number; h: number }, display?: number, inks?: Record<string, Ink>): SheetPlate[] {
  if (!screens.length) return [];
  const pieces = screens.map(mainPiece);
  const boxes = pieces.map(padded);
  const n = pieces.length;
  const W = SHEET.wide * card.w;
  const H = SHEET.wide * card.h;
  const g = SHEET.gap;
  const dens = (p: TitlePiece, b: Box) => pieceDensity(p, b, display);
  // Each layout's columns and rows; every piece takes one cell.
  const shapes = n === 1 ? [{ cols: 1, rows: 1 }] : [{ cols: 1, rows: n }, ...(n >= 2 ? [{ cols: 2, rows: Math.ceil(n / 2) }] : [])];
  let best: { s: number; cols: number; rows: number; cut: Box[]; cellH: number } | null = null;
  for (const { cols, rows } of shapes) {
    const cellW = (W - (cols - 1) * g) / cols;
    const cellH = (H - (rows - 1) * g) / rows;
    // One scale: as wide as the widest piece allows, never past its pixels,
    // and never so large that a cell has to cut into its change (its 16pt
    // of air round it included).
    let s = Math.min(...boxes.map((b, i) => Math.min(cellW / b.w, cellH / Math.min(b.h, pieces[i].box.h + 32), dens(pieces[i], b))));
    // A lone piece is also kept inside the card's height.
    if (n === 1) s = Math.min(s, cellH / boxes[0].h);
    const cut = boxes.map((b, i) => windowOf(b, cellH / s, pieces[i].box.y - 16));
    if (!best || s > best.s + 1e-6) best = { s, cols, rows, cut, cellH };
  }
  const { s, cols, rows, cellH } = best!;
  // Each crop ends on blank rows, inside its cell.
  const cut = best!.cut.map((b, i) => snapRows(b, inks && inks[screens[i].after.url], pieces[i].box, cellH / s));
  const colW = Math.max(...cut.map((b) => b.w * s));
  const rowH = (r: number) => Math.max(...cut.filter((_, i) => Math.floor(i / cols) === r).map((b) => b.h * s));
  const heights = Array.from({ length: rows }, (_, r) => rowH(r));
  const total = heights.reduce((a, v) => a + v, 0) + (rows - 1) * g;
  const x0 = (card.w - (cols * colW + (cols - 1) * g)) / 2;
  let y = card.h * SHEET.centre - total / 2;
  const plates: SheetPlate[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= n) break;
      // A row's last lone plate sits in the middle.
      const lone = cols > 1 && i === n - 1 && n % cols;
      const cx = lone ? card.w / 2 : x0 + c * (colW + g) + colW / 2;
      plates.push({ ...plateFor(pieces[i], cut[i], s, cx, y + heights[r] / 2, 10), screen: i, box: cut[i], s });
    }
    y += heights[r] + g;
  }
  return plates;
}

/**
 * What a screen's declared change is about on its after side: its frame
 * (the element its shots agent shot), else its own area (unwidened), else
 * the screen's largest area.
 */
function changeOf(screen: ReviewScreen): Box | null {
  const framed = frameBoxes(screen, 'after');
  if (framed.length) return framed.reduce((a, b) => (boxArea(b) > boxArea(a) ? b : a));
  const boxes = changedRegions(screen).map(afterBox).filter((b): b is Box => !!b && b.w > 2);
  if (!boxes.length) return largestRegion(screen);
  return boxes.reduce((a, b) => (boxArea(b) > boxArea(a) ? b : a));
}

/**
 * A screen that declares nothing and differs only by a speck (a clock that
 * ticked): what it is about is the screen itself, from its top. A screen
 * with a frame is about that frame, whatever differs.
 */
function onlySpeck(screen: ReviewScreen): boolean {
  if (frameBoxes(screen, 'after').length) return false;
  if (screen.regions.some((r) => r.n > 0 && !onlyMoved(r))) return false;
  const speck = changeOf(screen);
  return !speck || speck.w * Math.max(speck.h, 2) < 4000;
}

/** The declared change on both sides, with room round it: what an opened screen is framed on (its frame first). */
function changeFocus(screen: ReviewScreen, pad: number): Box {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const frame = frameBox(screen, ['before', 'after']);
  const boxes = frame ? [frame]
    : changedRegions(screen).flatMap((r) => [regionBox(r, 'before'), regionBox(r, 'after')]).filter((b): b is Box => !!b);
  if (!boxes.length) return focusBox(screen, ['before', 'after'], pad);
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.w)) + pad);
  const y1 = Math.min(H, Math.max(...boxes.map((b) => b.y + Math.max(b.h, 2))) + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * A screen as a pictogram (the strip's tile): the screen's outline at a
 * phone's proportions, `w` by `h`, and a bar on every place it changed, so
 * each pictogram points at where on that screen to look. The outline stands
 * for the screen's first phone-height, stretched down to take in the lowest
 * change. A mark goes on what each change is about (its frame) when the run
 * recorded one, else on each place that changed. Marks that touch at this
 * size are one mark; at most three, the largest, top to bottom. A removed part (a line, no height) still gets a
 * bar; a screen with no place recorded is the outline alone, rather than a
 * mark that points somewhere nothing changed.
 */
export function pictoMarks(screen: ReviewScreen, w: number, h: number): Box[] {
  const W = screen.width;
  // Where to look: what each change is about (its frame) when there is one.
  const framed = frameBoxes(screen, 'after');
  const boxes = framed.length ? framed : changedRegions(screen).map(afterBox).filter((b): b is Box => !!b && b.w > 0);
  if (!boxes.length) return [];
  const lowest = Math.max(...boxes.map((b) => b.y + Math.max(b.h, 2)));
  const H = Math.max(1, Math.min(screen.after.height, Math.max(W * 2.17, lowest)));
  const q = (v: number) => Math.round(v * 2) / 2;
  const marks = boxes.map((b) => {
    const mw = Math.max(3, q((Math.min(b.w, W) / W) * w));
    const mh = Math.max(2.5, q((Math.min(b.h, H) / H) * h));
    return { x: Math.max(0, Math.min(w - mw, q((b.x / W) * w))), y: Math.max(0, Math.min(h - mh, q((b.y / H) * h))), w: mw, h: mh };
  });
  const merged: Box[] = [];
  for (const m of marks) {
    const hit = merged.findIndex((o) => near(o, m, 1.5));
    if (hit < 0) merged.push(m);
    else merged[hit] = union2(merged[hit], m);
  }
  return merged.sort((a, b) => boxArea(b) - boxArea(a)).slice(0, 3).sort((a, b) => a.y - b.y);
}

/**
 * A screen's tile in the strip: a square of the screen round where its
 * declared change starts (text reads from its start), as large as the
 * still's pixels allow at `size` points. Returns where the screen goes in it.
 */
export function tileCrop(screen: ReviewScreen, size: number, display?: number, ink?: Ink | null): Placement {
  const big = (!onlySpeck(screen) && changeOf(screen)) || { x: 8, y: 8, w: screen.width - 16, h: 128 };
  const H = screen.after.height;
  const start = Math.max(96, Math.min(144, Math.min(big.w, Math.max(big.h, 2)) + 16, screen.width));
  const x = Math.max(0, Math.min(screen.width - start, big.x - 8));
  const yAt = (side: number) => (big.h + 16 >= side
    ? Math.max(0, Math.min(H - side, big.y - 8))
    : Math.max(0, Math.min(H - side, big.y + big.h / 2 - side / 2)));
  let side = start;
  let y = yAt(start);
  // The square's right edge and its top and bottom on blank pixels, so no
  // word is cut: the nearest size and place that has them.
  if (ink) {
    let best: { side: number; y: number; cost: number } | null = null;
    for (let s2 = 96; s2 <= Math.min(144, screen.width - x); s2++) {
      for (const dy of nearest(12)) {
        const y2 = yAt(s2) + dy;
        if (y2 < 0 || y2 + s2 > H) continue;
        const cost = Math.abs(s2 - start) + Math.abs(dy);
        if (best && cost >= best.cost) continue;
        if (colFlat(ink, x + s2, y2, y2 + s2) && rowFlat(ink, y2, x, x + s2) && rowFlat(ink, y2 + s2, x, x + s2)) best = { side: s2, y: y2, cost };
      }
    }
    if (best) { side = best.side; y = best.y; }
  }
  const scale = Math.min(densityOf(screen, display), size / side);
  const pad = (size - side * scale) / 2;
  return { scale, tx: pad - x * scale, ty: pad - y * scale };
}

/**
 * Where an opened screen sits in the picture: the change it declares (both
 * sides, never a row it only pushed along), as large as fits and never past
 * its pixels (densityOf), framed again below
 * the captions' band when its largest change would sit under them, and
 * ending above the switch when that change would sit under it. `cut` is
 * the largest change at that framing, in screen points: the hole the
 * landing dim leaves around it.
 */
export function openPlace(screen: ReviewScreen, view: { w: number; h: number }, display?: number): { place: Placement; cut: Box | null } {
  // Phone review #27 (23 Nov 2026): the slider's caption and switch are on
  // solid strips across its top and foot (compare.tsx CAP_STRIP,
  // FOOT_STRIP), so the screen is always placed in the room between them,
  // not only when its change would have been under the caption or the switch.
  const CAP = 30;
  const BOT = 64;
  const focus = changeFocus(screen, 16);
  const max = densityOf(screen, display);
  const big = changeOf(screen);
  const fit = (top: number, bot: number): Placement => {
    const p = placeBox(screen, focus, { w: view.w, h: view.h - top - bot }, max);
    const H = Math.max(screen.before.height, screen.after.height) * p.scale;
    let ty = p.ty + top;
    if (H >= view.h - bot) ty = Math.max(view.h - bot - H, Math.min(top, ty));
    return { ...p, ty };
  };
  const place = fit(CAP, BOT);
  if (!big) return { place, cut: null };
  // The hole: the largest change, kept 4pt inside what the picture shows.
  const vx = Math.max(0, place.tx); const vy = Math.max(0, place.ty);
  const vr = Math.min(view.w, place.tx + screen.width * place.scale);
  const vb = Math.min(view.h, place.ty + Math.max(screen.before.height, screen.after.height) * place.scale);
  const x0 = Math.max(vx + 4, big.x * place.scale + place.tx); const y0 = Math.max(vy + 4, big.y * place.scale + place.ty);
  const x1 = Math.min(vr - 4, (big.x + big.w) * place.scale + place.tx); const y1 = Math.min(vb - 4, (big.y + Math.max(big.h, 2)) * place.scale + place.ty);
  if (x1 <= x0 || y1 <= y0) return { place, cut: null };
  return { place, cut: { x: (x0 - place.tx) / place.scale, y: (y0 - place.ty) / place.scale, w: (x1 - x0) / place.scale, h: (y1 - y0) / place.scale } };
}

export type GlyphBar = { screen: number; x: number; y: number; w: number; h: number };

/**
 * The sheet in miniature: its plates as bars fitted into an `size` box at
 * `offset`, every edge on a whole device pixel. The strip's first tile and
 * the Next button draw it.
 */
export function glyphBars(plates: SheetPlate[], size: number, offset = 0, display = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): GlyphBar[] {
  if (!plates.length) return [];
  const x0 = Math.min(...plates.map((p) => p.x)); const y0 = Math.min(...plates.map((p) => p.y));
  const bw = Math.max(...plates.map((p) => p.x + p.w)) - x0; const bh = Math.max(...plates.map((p) => p.y + p.h)) - y0;
  const f = Math.min((26 * size) / 37 / bw, (27 * size) / 37 / bh);
  const ox = offset + (size - bw * f) / 2; const oy = offset + (size - bh * f) / 2;
  const q = (v: number) => Math.round(v * display) / display;
  const gap = size < 30 ? 0.5 : 1;
  return plates.map((p) => {
    const x = q(ox + (p.x - x0) * f + gap); const y = q(oy + (p.y - y0) * f + gap);
    return { screen: p.screen, x, y, w: q(ox + (p.x - x0 + p.w) * f - gap) - x, h: q(oy + (p.y - y0 + p.h) * f - gap) - y };
  });
}

/** The line under an opened screen: the change it shows, else the whole change's. */
export function screenLine(item: ReviewItem, screen: ReviewScreen | null): string {
  const n = screen && Array.isArray(screen.changes) ? screen.changes.find((k) => k > 0 && item.claims[k - 1]) : undefined;
  return n ? item.claims[n - 1] : item.line;
}
