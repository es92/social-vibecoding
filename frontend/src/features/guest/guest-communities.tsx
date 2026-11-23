/**
 * PRIVATE COMMUNITIES: the page a visitor with no account reads at
 * `/communities` (features/auth/story.tsx COMMUNITIES_PATH), in the guest
 * Discover's place on the landing (features/auth/landing.tsx).
 *
 * WHO IT IS FOR (Evan, 13 Nov 2026). The landing's own pitch is the public
 * library: apps anyone can edit. A private community is a different promise
 * (its maker says who gets in and who approves a change), for somebody who
 * runs a group: friends, a school club, a city's bridge club, a studio
 * collective, a street, a town. So it is a page of its own, behind a door on
 * the landing, and the page the people who go looking for such groups send
 * them. Its job is to let an organizer picture their own group here and
 * start one.
 *
 * THE B3 DESIGN (23 Nov 2026). Top to bottom:
 *   - the hero: the headline, its two buttons and three short points, beside
 *     A WALK THROUGH A COMMUNITY (HubDemo below), which plays four scenes in
 *     a window of the app: the hub, a change put to the vote, a comment left
 *     on the app itself, and the thread where that comment becomes a change;
 *   - what a group gets, six short cards on the green (four of them jump to
 *     their scene of the walk-through);
 *   - who it is for: a photograph for friend groups, two tinted cards, and
 *     three more kinds of group as a line each;
 *   - the four approval rules, on the green again;
 *   - a closing band on a soft sky, with the button again.
 *
 * DRAWN IN THE WEBSITE'S LOOK, as the landing's short story is: the hero is
 * the landing's frame (clouds, a white window, the lighter serif, the two
 * pills of features/auth/story.tsx). Every colour outside the walk-through
 * is a variable of public/css/app.css's "THE WEBSITE'S LOOK ON THE
 * SIGNED-OUT PAGES", which the dark shell moves, so nothing here names a
 * dark class. The walk-through is a picture of the app and keeps one
 * palette in both modes; its rules, and the sections' own, are that sheet's
 * "THE PAGE ABOUT PRIVATE COMMUNITIES".
 *
 * EVERY WORD IN THE WALK-THROUGH IS MADE UP, and says so by being a supper
 * club: its people's handles are constants here, never an account's.
 *
 * ONE WAY IN: the button opens the landing's own start sheet, and says
 * "Join the waitlist" while new accounts wait, as the bar's does. The white
 * button beside it goes back to the public apps, a plain link to `/`: this
 * page and the guest Discover are two addresses of one document.
 *
 * Mounted only at its address, never in the prerender, so nothing here is in
 * the landing's first commit.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

import {
  AppWindowIcon,
  ArrowRightShortIcon,
  BallotIcon,
  BellIcon,
  BoardIcon,
  BookmarkIcon,
  ChatBubbleTailIcon,
  ChatIcon,
  CheckIcon,
  CupIcon,
  EyeIcon,
  HandRaisedIcon,
  HashIcon,
  HomeIcon,
  HomeroomBotIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  Squares2X2Icon,
  TrophyOutlineIcon,
  UserCheckIcon,
  UserGroupIcon,
} from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { reducedMotion } from '../../lib/reduced-motion';
import { noteSignUpFrom } from '../auth/sign-up-from';
import { HERO_PRIMARY, HERO_SECONDARY, SITE_LABEL } from '../auth/story';

// This page's headings are the hero's serif (--site-serif is Source Serif 4
// under [data-guest-groups]), a touch heavier and tighter than the landing's.
const SERIF = 'font-[family-name:var(--site-serif)] font-[460] tracking-[-0.02em]';
// The page's own headline.
const HEADLINE = "font-[family-name:var(--site-display)] font-[460] [font-variation-settings:'opsz'_28] text-[31px] leading-[35px] tracking-[-0.02em] text-[color:var(--site-ink)] text-balance md:text-[46px] md:leading-[50px] xl:text-[54px] xl:leading-[58px]";
// A white face on an ink outline: the site's card.
const CARD = 'rounded-[14px] border border-[color:var(--site-line)] bg-[var(--site-panel)]';

/**
 * The walk-through's four scenes, in the order they play. `ms` is how long a
 * scene stays up; `steps` are [milliseconds in, step]: a part of the scene
 * drawn for step k arrives when k is reached, so the steps of a scene count
 * up from 1.
 */
export const SCENES = [
  { key: 'hub', ms: 6400, steps: [[150, 1], [600, 2], [1100, 3], [1500, 4], [2800, 5], [3800, 6]] },
  { key: 'needs', ms: 7200, steps: [[150, 1], [1300, 2], [2300, 3], [3600, 4], [4400, 5]] },
  { key: 'app', ms: 7600, steps: [[300, 1], [1300, 2], [1700, 3], [4000, 4], [4500, 5]] },
  { key: 'workshop', ms: 7400, steps: [[150, 1], [1300, 2], [2600, 3], [3900, 4]] },
] as const;
// The comment is typed out when the third scene reaches this step.
const TYPE_STEP = 3;
// After the pointer leaves the window, the next scene starts this much later.
export const RESUME_MS = 1400;

/** A scene's last step: where it stands once it has played out. */
export function lastStep(scene: number): number {
  const steps = SCENES[scene].steps;
  return steps[steps.length - 1][1];
}

// The supper club's people. Made up, and only ever drawn here.
const MAYA = 'maya.eats';
const SAM = 'samwich';
const LEO = 'leo_bakes';
const PRIYA = 'priyaaa';
const ACTIVE = [MAYA, 'kai', SAM, 'ari.k', LEO];

/** Somebody's face: a brand character or a photograph (`pic`), or an initial. */
function Avatar({ look, children }: { look: string; children?: ReactNode }) {
  return <span className={`hr-av ${look}`} aria-hidden="true">{children}</span>;
}

/**
 * The supper club's own app, as its members made it: this Friday's supper
 * and who is bringing what. Drawn three times (small on the hub, small
 * beside the change, large under the comment), sized by its box's font
 * size. `dessert` is what the comment scene adds to the one open row.
 */
function SupperApp({ dessert }: { dessert?: { className: string; extra: ReactNode } }) {
  const t = useMessages('auth');
  return (
    <div className="sc-app">
      <div className="sc-top"><span className="live">{t('auth:guest.groups.demo.app.when')}</span><span className="meta">{t('auth:guest.groups.demo.app.volume')}</span></div>
      <div className="sc-h">{t('auth:guest.groups.demo.app.title')}</div>
      <div className="sc-chips"><span>{t('auth:guest.groups.demo.app.time')}</span><span>{t('auth:guest.groups.demo.app.place')}</span><span>{t('auth:guest.groups.demo.app.going')}</span></div>
      <div className="sc-list">
        <div className="sc-row"><span className="ini">S</span>{t('auth:guest.groups.demo.app.broth')}<span className="who">{SAM}</span></div>
        <div className="sc-row"><span className="ini">M</span>{t('auth:guest.groups.demo.app.noodles')}<span className="who">{MAYA}</span></div>
        <div className={`sc-row open${dessert ? dessert.className : ''}`}>
          <span className="ini">+</span>{t('auth:guest.groups.demo.app.dessert')}<span className="claim">{t('auth:guest.groups.demo.app.claim')}</span>
          {dessert ? dessert.extra : null}
        </div>
        <div className="sc-row"><span className="ini">L</span>{t('auth:guest.groups.demo.app.drinks')}<span className="who">{LEO}</span></div>
      </div>
    </div>
  );
}

/**
 * A WALK THROUGH A COMMUNITY. Four scenes play in turn in a window of the
 * app; the tab under the window fills while its scene plays. A pointer over
 * the window holds the scene, played out, and leaving starts the next one;
 * a tab jumps to its scene. Somebody who asked for less motion gets each
 * scene played out and still, and moves with the tabs.
 *
 * One state says where it is: the scene, how far its steps have got, and
 * whether it is held. `run` counts every start, so a scene asked for again
 * starts again (its timers and its tab's bar are keyed on it).
 */
function HubDemo({ go }: { go: MutableRefObject<((scene: number) => void) | null> }) {
  const t = useMessages('auth');
  const td = useMessages('dialogs');
  const root = useRef<HTMLDivElement | null>(null);
  const resume = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState({ scene: 0, run: 0, step: 0, held: false });
  const feedback = t('auth:guest.groups.demo.comment.text');
  // How much of the comment has been typed.
  const [typed, setTyped] = useState(0);

  const show = useCallback((scene: number) => {
    if (resume.current) clearTimeout(resume.current);
    setAt((was) => ({ scene: (scene + SCENES.length) % SCENES.length, run: was.run + 1, step: 0, held: false }));
  }, []);
  // The cards under the hero ask for a scene and bring the window into view.
  go.current = (scene) => {
    show(scene);
    root.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  };
  useEffect(() => () => { if (resume.current) clearTimeout(resume.current); }, []);

  useEffect(() => {
    const scene = SCENES[at.scene];
    if (reducedMotion()) {
      // Played out and still: no timer moves it on.
      setTyped(feedback.length);
      setAt((was) => (was.held && was.step === lastStep(was.scene) ? was : { ...was, step: lastStep(was.scene), held: true }));
      return undefined;
    }
    if (at.held) return undefined;
    setTyped(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [ms, step] of scene.steps) {
      timers.push(setTimeout(() => setAt((was) => ({ ...was, step })), ms));
      if (scene.key === 'app' && step === TYPE_STEP) {
        const each = Math.max(18, Math.min(45, 1900 / Math.max(1, feedback.length)));
        for (let n = 1; n <= feedback.length; n += 1) timers.push(setTimeout(() => setTyped(n), ms + n * each));
      }
    }
    timers.push(setTimeout(() => show(at.scene + 1), scene.ms));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [at.scene, at.run, at.held, feedback.length, show]);

  const hold = () => {
    if (reducedMotion()) return;
    if (resume.current) clearTimeout(resume.current);
    setTyped(feedback.length);
    setAt((was) => ({ ...was, step: lastStep(was.scene), held: true }));
  };
  const letGo = () => {
    if (reducedMotion()) return;
    if (resume.current) clearTimeout(resume.current);
    resume.current = setTimeout(() => show(at.scene + 1), RESUME_MS);
  };

  // A part drawn for step `k` of scene `n` has arrived.
  const reached = (n: number, k: number) => at.scene === n && at.step >= k;
  const on = (n: number, k: number) => (reached(n, k) ? ' on' : '');
  const up = (n: number) => (at.scene === n ? ' is-on' : '');
  const nav = (key: string) => (SCENES[at.scene].key === key ? 'hx-nav is-on' : 'hx-nav');

  const club = t('auth:guest.groups.demo.club.name');
  const now = t('auth:guest.groups.demo.now');
  const yes = reached(1, 4) ? 5 : reached(1, 3) ? 4 : 3;
  const typing = reached(2, TYPE_STEP);
  const tabs = [
    t('auth:guest.groups.demo.tab.hub'),
    t('auth:guest.groups.demo.tab.vote'),
    t('auth:guest.groups.demo.tab.comment'),
    t('auth:guest.groups.demo.tab.talk'),
  ];

  return (
    <div ref={root} className={at.held ? 'hr-demo held' : 'hr-demo'} data-guest-groups-demo={SCENES[at.scene].key} role="region" aria-label={t('auth:guest.groups.demo.label')}>
      <div className="hx-win" onMouseEnter={hold} onMouseLeave={letGo}>
        <div className="hx-body">
          <nav className="hx-side" aria-hidden="true">
            <Wordmark className="hx-logo" />
            <span className="hx-nav"><HomeIcon />{t('auth:guest.groups.demo.side.home')}</span>
            <span className="hx-nav"><UserGroupIcon />{t('auth:guest.groups.demo.side.communities')}</span>
            <span className="hx-nav"><HomeroomBotIcon />{t('auth:guest.groups.demo.side.bot')}</span>
            <span className="hx-nav"><ChatIcon />{t('auth:guest.groups.demo.side.messages')}<em>6</em></span>
            <span className="hx-sep" />
            <small>{t('auth:guest.groups.demo.side.projects')}</small>
            <span className="hx-comm"><span className="hx-tile"><CupIcon /></span><span>{club}</span></span>
            <div className="hx-tree">
              <span className={nav('app')}><AppWindowIcon />{t('auth:guest.groups.demo.side.app')}</span>
              <span className={nav('hub')}><Squares2X2Icon />{t('auth:guest.groups.demo.side.hub')}</span>
              <span className={nav('needs')}><BallotIcon />{t('auth:guest.groups.demo.side.needs')}<em>1</em></span>
              <span className={nav('workshop')}><BoardIcon />{t('auth:guest.groups.demo.side.workshop')}</span>
              <span className="hx-nav"><HashIcon />{t('auth:guest.groups.demo.side.general')}</span>
            </div>
          </nav>
          <div className="hx-main">
            <div className="hx-top" aria-hidden="true">
              <span className="hx-search"><SearchIcon />{t('auth:guest.groups.demo.search')}<kbd>⌘K</kbd></span>
              <span className="hx-bell"><BellIcon /><i /></span>
              <Avatar look="pic av-f3 lg" />
            </div>

            {/* The hub: who is here, the app, and what needs you. */}
            <section className={`hr-scene${up(0)}`} data-scene="hub">
              <div className={`hx-title hr-step hr-rise${on(0, 1)}`}>
                <span className="hx-tile lg"><CupIcon /></span>
                <span>{club}<small>{t('auth:guest.groups.demo.club.kind')}</small></span>
              </div>
              <div className={`hx-banner hr-step hr-rise${on(0, 2)}`}>
                <div>
                  <b>{t('auth:guest.groups.demo.hub.banner.title')}</b>
                  <p>{t('auth:guest.groups.demo.hub.banner.body')}</p>
                  <div className="hx-btns">
                    <span className="hx-btn sun">{t('auth:guest.groups.demo.hub.open')} <ArrowRightShortIcon /></span>
                    <span className="hx-btn white">{t('auth:guest.groups.demo.hub.invite')}</span>
                  </div>
                </div>
                <div className="hx-mini-app"><SupperApp /></div>
              </div>
              <div className={`hx-card hx-active hr-step hr-rise${on(0, 3)}`}>
                <span className="hx-stack">
                  <Avatar look="pic av-f1" /><Avatar look="pic av-kai" /><Avatar look="pic av-m3" /><Avatar look="y">A</Avatar><Avatar look="pic av-m4" /><Avatar look="hx-more">+4</Avatar>
                </span>
                <div><b>{t('auth:guest.groups.demo.hub.active')}</b><span>{`${ACTIVE.join(', ')}…`}</span></div>
              </div>
              <div className={`hx-h hr-step hr-rise${on(0, 4)}`}>{t('auth:guest.groups.demo.hub.forYou')}</div>
              <div className={`hx-foryou hr-step hr-rise${on(0, 4)}`}>
                <div className={`hx-tilecard y press${on(0, 6)}`}>
                  <span className="ico"><SparklesIcon /></span>
                  <div><b>{t('auth:guest.groups.demo.side.needs')}</b><span>{t('auth:guest.groups.demo.hub.needs')}</span></div>
                  <em>1</em>
                  <span className={`hr-cursor${on(0, 5)}`} style={{ insetInlineEnd: 30, top: 16 }} />
                </div>
                <div className="hx-tilecard b">
                  <span className="ico"><BoardIcon /></span>
                  <div><b>{t('auth:guest.groups.demo.side.workshop')}</b><span>{t('auth:guest.groups.demo.hub.workshop')}</span></div>
                </div>
              </div>
              <div className={`hx-card hx-thread-row hr-step hr-rise${on(0, 4)}`}>
                <span className="ico"><HashIcon /></span>
                <div><b>{t('auth:guest.groups.demo.hub.chat')}</b><span>{t('auth:guest.groups.demo.hub.chatBy', { name: SAM })}</span></div>
                <span className="hx-stack"><Avatar look="pic av-m3 sm" /><Avatar look="pic av-zoe sm" /><Avatar look="pic av-f4 sm" /></span>
                <span className="hx-count"><ChatBubbleTailIcon />12</span>
              </div>
            </section>

            {/* A change put to the group: try it, vote, and it goes live. */}
            <section className={`hr-scene${up(1)}`} data-scene="needs">
              <div className="hx-title">{t('auth:guest.groups.demo.side.needs')}</div>
              <div className="hx-sub">{t('auth:guest.groups.demo.needs.sub')}</div>
              <div className={`hx-card hx-prop hr-step hr-rise${on(1, 1)}`}>
                <div className="hx-by">
                  <Avatar look="pic av-f1 sm" />
                  <span><RichMessage id="auth:guest.groups.demo.needs.by" values={{ name: MAYA }} components={[<b />]} /></span>
                  <span className="hx-pill blue">{td('dialogs:whoDecides.preset.group_vote.name')}</span>
                </div>
                <h5>{t('auth:guest.groups.demo.needs.change')}</h5>
                <div className="hx-pv">
                  <div className="frame"><SupperApp /></div>
                  <div className="note">
                    <b>{t('auth:guest.groups.demo.needs.tryTitle')}</b>
                    <span>{t('auth:guest.groups.demo.needs.tryBody')}</span>
                    <span className="hx-btn white"><EyeIcon />{t('auth:guest.groups.demo.needs.preview')}</span>
                  </div>
                </div>
                <div className="hx-tally">
                  <span className="hx-stack">
                    <Avatar look="pic av-m3 sm" /><Avatar look="pic av-zoe sm" /><Avatar look="pic av-f4 sm" />
                    <Avatar look={`pic av-f3 sm hr-step hr-pop${on(1, 3)}`} /><Avatar look={`pic av-m4 sm hr-step hr-pop${on(1, 4)}`} />
                  </span>
                  <span className="hx-track"><span className="hx-fill" style={{ width: `${yes * 20}%` }} /></span>
                  <span>{t('auth:guest.groups.demo.needs.tally', { yes, all: 5 })}</span>
                </div>
                <div className="hx-acts">
                  <span className={`hx-btn vote${on(1, 3)}`}>{reached(1, 3) ? t('auth:guest.groups.demo.needs.voted') : t('auth:guest.groups.demo.needs.vote')}</span>
                  <span className="hx-btn line">{t('auth:guest.groups.demo.needs.notYet')}</span>
                  <span className={`hr-cursor${on(1, 2)}`} style={{ insetInlineStart: 36, top: 12 }} />
                  <span className={`hx-pill green hr-step hr-pop${on(1, 5)}`}><CheckIcon />{t('auth:guest.groups.demo.needs.approved')}</span>
                </div>
              </div>
            </section>

            {/* A comment left on the app itself, at the spot it is about. */}
            <section className={`hr-scene${up(2)}`} data-scene="app">
              <div className="hx-cm-bar">
                <span className="ico"><ChatBubbleTailIcon /></span>
                <span><RichMessage id="auth:guest.groups.demo.comment.mode" components={[<b />]} /></span>
                <span className="tog" />
              </div>
              <div className="hx-cm-stage">
                <SupperApp
                  dessert={{
                    className: ` hl hr-step${on(2, 1)}`,
                    extra: (
                      <>
                        <span className={`hx-pin hr-step hr-pop${on(2, 2)}`} />
                        <span className={`hr-cursor${on(2, 1)}`} style={{ insetInlineEnd: '23%', top: 3 }} />
                        <div className={`hx-compose-at hr-step hr-out${on(2, 5)}`}>
                          <div className={`hx-compose hr-step hr-rise${on(2, 2)}`}>
                            <div className="hd"><Avatar look="pic av-f3 sm" />{t('auth:guest.groups.demo.comment.on')}</div>
                            <div className={typing && typed < feedback.length ? 'tx typing' : 'tx'} data-placeholder={t('auth:guest.groups.demo.comment.placeholder')}>{typing ? feedback.slice(0, typed) : ''}</div>
                            <div className="ft">
                              <span>{t('auth:guest.groups.demo.comment.goes')}</span>
                              <span className={`send${on(2, 4)}`}>{t('auth:guest.groups.demo.comment.send')} <SendIcon /></span>
                            </div>
                          </div>
                        </div>
                      </>
                    ),
                  }}
                />
                <div className={`hx-toast hr-step hr-rise${on(2, 5)}`}><span className="ok"><CheckIcon /></span>{t('auth:guest.groups.demo.comment.sent')}</div>
              </div>
            </section>

            {/* The thread where that comment becomes a change. */}
            <section className={`hr-scene${up(3)}`} data-scene="workshop">
              <div className="hx-title">{t('auth:guest.groups.demo.side.workshop')}</div>
              <div className="hx-sub">{t('auth:guest.groups.demo.workshop.sub')}</div>
              <div className={`hx-card hx-ws hr-step hr-rise${on(3, 1)}`}>
                <div className="hx-ws-head">
                  <h5>{t('auth:guest.groups.demo.workshop.title')}</h5>
                  <span className={`hx-pill grey${on(3, 4)}`}>{reached(3, 4) ? t('auth:guest.groups.demo.workshop.upForVote') : t('auth:guest.groups.demo.workshop.feedback')}</span>
                </div>
                <div className="hx-fb">
                  <Avatar look="pic av-f3 lg" />
                  <div className="tx"><span><RichMessage id="auth:guest.groups.demo.workshop.left" components={[<b />, <b />]} /></span>{feedback}</div>
                </div>
                <div className="hx-thread">
                  <div className={`hx-msg hr-step hr-rise${on(3, 2)}`}>
                    <Avatar look="pic av-f1 lg" />
                    <div><b>{MAYA}</b><time>{now}</time><p>{t('auth:guest.groups.demo.workshop.replyMaya')}</p></div>
                  </div>
                  <div className={`hx-msg hr-step hr-rise${on(3, 3)}`}>
                    <Avatar look="k lg"><HomeroomBotIcon /></Avatar>
                    <div>
                      <b>{t('auth:guest.groups.demo.side.bot')}</b><span className="hx-pill blue bot">{t('auth:guest.groups.demo.workshop.botTag')}</span><time>{now}</time>
                      <p>{t('auth:guest.groups.demo.workshop.replyBot')}</p>
                      <span className="hx-btn white"><EyeIcon />{t('auth:guest.groups.demo.workshop.previewChange')}</span>
                    </div>
                  </div>
                  <div className={`hx-msg hr-step hr-rise${on(3, 4)}`}>
                    <Avatar look="lg">P</Avatar>
                    <div><b>{PRIYA}</b><time>{now}</time><p>{t('auth:guest.groups.demo.workshop.replyPriya')}</p></div>
                  </div>
                </div>
                <div className="hx-reply">{t('auth:guest.groups.demo.workshop.replyBox')}<SendIcon /></div>
              </div>
            </section>
          </div>
        </div>
      </div>
      <div className="hr-tabs" role="tablist" aria-label={t('auth:guest.groups.demo.tabs')}>
        {tabs.map((label, n) => (
          <button
            key={SCENES[n].key}
            type="button"
            role="tab"
            aria-selected={at.scene === n}
            data-guest-groups-tab={SCENES[n].key}
            className={`hr-tab${up(n)}${n < at.scene ? ' done' : ''}`}
            style={{ ['--d' as string]: `${SCENES[n].ms}ms` }}
            onClick={() => show(n)}
          >
            <span className="bar"><i key={at.scene === n ? at.run : -1} /></span>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GuestCommunities({ waitlist, onStart }: {
  /** New accounts wait in line: the button says so (guest-data newAccountsWait). */
  waitlist: boolean;
  /** The landing's own way in (its start sheet). */
  onStart: () => void;
}) {
  const t = useMessages('auth');
  // The walk-through's way to be asked for a scene (HubDemo sets it).
  const go = useRef<((scene: number) => void) | null>(null);

  const start = () => { noteSignUpFrom('groups'); onStart(); };
  const startLabel = waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.groups.start');

  const points = [
    t('auth:guest.groups.points.private'),
    t('auth:guest.groups.points.vote'),
    t('auth:guest.groups.points.noCode'),
  ];

  // What a group gets. `scene` is the part of the walk-through that shows
  // it, where one does.
  const gets: { key: string; title: string; body: string; scene?: number }[] = [
    { key: 'private', title: t('auth:guest.groups.gets.private.title'), body: t('auth:guest.groups.gets.private.body') },
    { key: 'around', title: t('auth:guest.groups.gets.around.title'), body: t('auth:guest.groups.gets.around.body'), scene: 0 },
    { key: 'vote', title: t('auth:guest.groups.gets.vote.title'), body: t('auth:guest.groups.gets.vote.body'), scene: 1 },
    { key: 'comment', title: t('auth:guest.groups.gets.comment.title'), body: t('auth:guest.groups.gets.comment.body'), scene: 2 },
    { key: 'talk', title: t('auth:guest.groups.gets.talk.title'), body: t('auth:guest.groups.gets.talk.body'), scene: 3 },
    { key: 'credit', title: t('auth:guest.groups.gets.credit.title'), body: t('auth:guest.groups.gets.credit.body') },
  ];

  // The three kinds of group drawn as cards, then three more as a line each
  // under a rule: six identical cards read as a flat list.
  const tinted: { key: string; tint: string; icon: ReactNode; title: string; body: string }[] = [
    { key: 'school', tint: 'blue', icon: <BookmarkIcon />, title: t('auth:guest.groups.for.school.title'), body: t('auth:guest.groups.for.school.body') },
    { key: 'clubs', tint: 'green', icon: <TrophyOutlineIcon />, title: t('auth:guest.groups.for.clubs.title'), body: t('auth:guest.groups.for.clubs.body') },
  ];
  const plain = [
    { key: 'studios', title: t('auth:guest.groups.for.studios.title'), body: t('auth:guest.groups.for.studios.body') },
    { key: 'neighbors', title: t('auth:guest.groups.for.neighbors.title'), body: t('auth:guest.groups.for.neighbors.body') },
    { key: 'towns', title: t('auth:guest.groups.for.towns.title'), body: t('auth:guest.groups.for.towns.body') },
  ];

  // The four presets a community picks from (services/governance-rules.js),
  // in the Who decides dialog's order, each with a short line of its own; a
  // new community starts on the first.
  const rules: { key: string; icon: ReactNode; name: string; line: string }[] = [
    { key: 'you_or_the_group', icon: <UserCheckIcon className="h-5 w-5" />, name: t('auth:guest.groups.rules.you_or_the_group.name'), line: t('auth:guest.groups.rules.you_or_the_group.line') },
    { key: 'two_yeses', icon: <UserGroupIcon className="h-5 w-5" />, name: t('auth:guest.groups.rules.two_yeses.name'), line: t('auth:guest.groups.rules.two_yeses.line') },
    { key: 'open_floor', icon: <HandRaisedIcon className="h-5 w-5" />, name: t('auth:guest.groups.rules.open_floor.name'), line: t('auth:guest.groups.rules.open_floor.line') },
    { key: 'group_vote', icon: <BallotIcon className="h-5 w-5" />, name: t('auth:guest.groups.rules.group_vote.name'), line: t('auth:guest.groups.rules.group_vote.line') },
  ];

  return (
    <div data-guest-groups="" className="flex w-full grow flex-col">
      {/* THE LANDING'S HERO FRAME: the white window on the clouds. Its words
          are on the left from lg (centred above the walk-through below it),
          and the walk-through sits in a column of the page's ground. */}
      <section className="site-band site-clouds [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-6 md:pt-5 md:pb-6">
        <div className="border border-[color:var(--site-line)] bg-[var(--site-panel)] lg:grid lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-stretch">
          <div className="flex min-w-0 flex-col items-center px-4 pt-6 pb-6 text-center md:px-8 md:pt-10 md:pb-12 lg:items-start lg:justify-center lg:py-14 lg:ps-12 lg:pe-10 lg:text-start">
            <div className={`${SITE_LABEL} hidden md:block`}>{t('auth:guest.groups.label')}</div>
            <h1 className={`${HEADLINE} md:mt-4`}>
              {t('auth:guest.groups.title')}
            </h1>
            <p className="mt-3 text-balance text-[17px] leading-[24px] text-[color:var(--site-muted)] md:mt-4 md:text-[20px] md:leading-[28px]">
              <RichMessage id="auth:guest.groups.sub" components={[<span className="block" />, <span className="block" />]} />
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2.5 md:mt-6 lg:justify-start">
              <button type="button" data-guest-groups-start="" className={HERO_PRIMARY} onClick={start}>
                {startLabel}
              </button>
              <a href="/" data-guest-groups-public="" className={HERO_SECONDARY}>
                {t('auth:guest.groups.explore')}
              </a>
            </div>
            <ul data-guest-groups-points="" className="hr-points">
              {points.map((point) => (
                <li key={point}><CheckIcon strokeWidth="2.4" aria-hidden="true" />{point}</li>
              ))}
            </ul>
          </div>
          <div className="hr-demo-col" data-guest-groups-hub="">
            <HubDemo go={go} />
          </div>
        </div>
      </section>

      {/* WHAT YOUR GROUP GETS, on the green with stars. */}
      <section data-guest-groups-gets="" className="wg site-stars">
        <div className="wg-head">
          <span className="hw-eyebrow">{t('auth:guest.groups.gets.label')}</span>
          <h2>{t('auth:guest.groups.gets.heading')}</h2>
        </div>
        <ul className="wg-grid">
          {gets.map((item) => (
            <li key={item.key} className="wg-item" data-guest-groups-get={item.key}>
              <img className="wg-img" src={`/brand/groups/benefit-${item.key}.webp`} alt="" width={56} height={56} loading="lazy" draggable={false} />
              <div>
                <h3>
                  {item.scene === undefined ? item.title : (
                    <button type="button" className="wg-go" title={t('auth:guest.groups.gets.see')} onClick={() => go.current?.(item.scene!)}>
                      {item.title}
                    </button>
                  )}
                </h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* WHO IT IS FOR. */}
      <section data-guest-groups-for="" className="gr">
        <div className="gr-head">
          <span className="hw-eyebrow">{t('auth:guest.groups.for.label')}</span>
          <h2>{t('auth:guest.groups.for.heading')}</h2>
          <p>{t('auth:guest.groups.for.sub')}</p>
        </div>
        <div className="gr-grid">
          <article className="gr-photo" data-guest-groups-kind="friends">
            <span className="gr-tile"><UserGroupIcon aria-hidden="true" /></span>
            <h3>{t('auth:guest.groups.for.friends.title')}</h3>
            <p>{t('auth:guest.groups.for.friends.body')}</p>
            <span className="gr-go" aria-hidden="true"><ArrowRightShortIcon /></span>
          </article>
          <div className="gr-side">
            {tinted.map((kind) => (
              <article key={kind.key} className={`gr-card ${kind.tint}`} data-guest-groups-kind={kind.key}>
                <span className="gr-tile" aria-hidden="true">{kind.icon}</span>
                <div><h3>{kind.title}</h3><p>{kind.body}</p></div>
                <span className="gr-go" aria-hidden="true"><ArrowRightShortIcon /></span>
              </article>
            ))}
          </div>
        </div>
        <ul className="gr-more">
          {plain.map((kind) => (
            <li key={kind.key} data-guest-groups-kind={kind.key}>
              <h3>{kind.title}<ArrowRightShortIcon aria-hidden="true" /></h3>
              <p>{kind.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* YOUR GROUP, YOUR RULES, on the green again. Its heading and line
          are black in both modes, as the green is the same in both. */}
      <section data-guest-groups-decides="" className="site-stars flex flex-col gap-6 px-4 py-12 md:gap-7 md:py-[68px]">
        <div className="flex flex-col gap-2.5">
          <h2 className={`${SERIF} text-[28px] leading-[34px] text-[color:var(--site-on-band)] text-balance md:text-[38px] md:leading-[44px]`}>{t('auth:guest.groups.decides.heading')}</h2>
          <p className="max-w-[640px] text-[17px] leading-[26px] text-[color:var(--site-on-band)] text-balance">{t('auth:guest.groups.decides.lead')}</p>
        </div>
        <ul data-guest-groups-rules="" className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {rules.map((rule, n) => (
            <li key={rule.key} data-guest-groups-rule={rule.key} className={`${CARD} flex min-w-0 flex-col gap-2.5 p-5`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-mint)] text-[color:var(--site-ink)]" aria-hidden="true">{rule.icon}</span>
                {n === 0 ? (
                  <span className="inline-flex h-[22px] items-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] px-2.5 text-xs font-semibold text-[color:var(--site-ink)]">{t('auth:guest.groups.decides.default')}</span>
                ) : null}
              </div>
              <h3 className={`${SERIF} text-[21px] leading-[26px] text-[color:var(--site-ink)]`}>{rule.name}</h3>
              <p className="text-[15px] leading-[21px] text-[color:var(--site-muted)]">{rule.line}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* The closing band, on a soft sky. */}
      <section data-guest-groups-closing="" className="site-sky-soft flex flex-col items-center gap-3 px-4 py-14 text-center md:py-[72px]">
        <h2 className={`${SERIF} text-[34px] leading-10 text-[color:var(--site-on-band)] text-balance md:text-[46px] md:leading-[52px]`}>{t('auth:guest.groups.closing.title')}</h2>
        <p className="max-w-[480px] text-[17px] leading-[25px] text-[color:var(--site-on-band)] opacity-80">{t('auth:guest.groups.closing.body')}</p>
        <button type="button" data-guest-groups-start="" className="hr-cta mt-2.5 inline-flex h-12 items-center justify-center rounded-full px-7 text-base font-semibold un-touch-target" onClick={start}>
          {startLabel}
        </button>
      </section>
    </div>
  );
}
