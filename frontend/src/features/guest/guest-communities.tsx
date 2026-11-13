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
 * Top to bottom: the headline with one button, the kinds of group it is for
 * (cards, each with what that group might make), how it works as three
 * steps down one card, who decides (what approval means for the group,
 * beside the four rules a community can pick), how a community goes from
 * just you to private to public, and a closing band with the button again.
 * Each section is drawn its own way on purpose: six sections of identical
 * cards read as one long list.
 *
 * DRAWN IN THE WEBSITE'S LOOK (13 Nov 2026), as the landing's short story
 * is: a sky band with a white window for the headline, then bands of the
 * site's colours down the page, serif headings, sun on an ink outline. Every
 * colour is a variable of public/css/app.css's "THE WEBSITE'S LOOK ON THE
 * SIGNED-OUT PAGES", which the dark shell moves, so nothing here names a
 * dark class. The first button is the Button primitive, repainted there.
 *
 * THE APPROVAL RULES ARE THE PRODUCT'S: their names and lines are the Who
 * decides dialog's own messages (features/dialogs/who-decides.tsx), and the
 * three audiences are the Communities screen's nouns, so this page cannot
 * describe a rule or an audience the product does not have.
 *
 * ONE WAY IN: the button opens the landing's own start sheet, and says
 * "Join the waitlist" while new accounts wait, as the bar's does. The links
 * back to the public apps are plain links to `/`: this page and the guest
 * Discover are two addresses of one document.
 *
 * Mounted only at its address, never in the prerender, so nothing here is in
 * the landing's first commit.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  BallotIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronLeftIcon,
  CupIcon,
  GlobeIcon,
  HandRaisedIcon,
  HomeIcon,
  LockIcon,
  NewspaperIcon,
  TrophyOutlineIcon,
  UserCheckIcon,
  UserGroupIcon,
} from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { noteSignUpFrom } from '../auth/sign-up-from';

const SERIF = 'font-[family-name:var(--site-serif)] font-normal';
// The page's own headline.
const HEADLINE = `${SERIF} text-[32px] leading-9 tracking-[-0.015em] text-[color:var(--site-ink)] text-balance md:text-[50px] md:leading-[54px]`;
// A section's heading: larger than a label over a card, smaller than the
// page's own headline.
const HEADING = `${SERIF} text-[28px] leading-[34px] tracking-[-0.01em] text-[color:var(--site-ink)] text-balance md:text-[38px] md:leading-[44px]`;
// The small label a band opens with, as the site sets "How it works".
const LABEL = 'text-[13px] leading-[18px] uppercase tracking-[0.05em] text-[color:var(--site-ink)]';
// The line under a heading, and the paragraph beside the rules.
const SUB = 'max-w-[640px] text-[17px] leading-[26px] text-[color:var(--site-muted)] text-balance';
// A white face on an ink outline: the site's card.
const CARD = 'rounded-[14px] border border-[color:var(--site-line)] bg-[var(--site-panel)]';
// A card's or a row's title, in the serif, over its line.
const ROW_TITLE = `${SERIF} text-[21px] leading-[26px] text-[color:var(--site-ink)]`;
const ROW_LINE = 'text-[15px] leading-[21px] text-[color:var(--site-muted)]';
// A link inside a sentence: ink, underlined (the site has no second accent).
const LINK = 'font-semibold text-[color:var(--site-ink)] underline decoration-1 underline-offset-[3px]';
// A band's own padding, top and bottom, inside the column's gutter.
const BAND = 'flex flex-col gap-6 px-4 py-12 md:gap-7 md:py-[68px]';
// The strip a window opens with, and one of its three dots.
const STRIP = 'flex h-6 items-center gap-1.5 border-b border-[color:var(--site-line)] px-2.5 md:h-8 md:px-3';
const DOT = 'h-2 w-2 rounded-full border border-[color:var(--site-line)] md:h-2.5 md:w-2.5';
// The glyph tile a kind of group leads with: one of three fills in turn. Sun
// keeps its ink glyph in the dark shell; the two pale fills follow the ink.
const TILE = 'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--site-line)]';
const TILE_FILLS = [
  'bg-[var(--site-sun)] text-[color:var(--site-on-sun)]',
  'bg-[var(--site-sky-pale)] text-[color:var(--site-ink)]',
  'bg-[var(--site-mint)] text-[color:var(--site-ink)]',
];
// The round sun disc a check, a rule's glyph and a stage's glyph sit on.
const SUN_DISC = 'flex shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sun)] text-[color:var(--site-on-sun)]';

export function GuestCommunities({ waitlist, onStart }: {
  /** New accounts wait in line: the button says so (guest-data newAccountsWait). */
  waitlist: boolean;
  /** The landing's own way in (its start sheet). */
  onStart: () => void;
}) {
  const t = useMessages('auth');
  const td = useMessages('dialogs');
  const tc = useMessages('communities');

  const start = () => { noteSignUpFrom('groups'); onStart(); };
  const startLabel = waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.groups.start');

  const groups: { key: string; icon: ReactNode; title: string; body: string }[] = [
    { key: 'friends', icon: <UserGroupIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.friends.title'), body: t('auth:guest.groups.for.friends.body') },
    { key: 'school', icon: <BookmarkIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.school.title'), body: t('auth:guest.groups.for.school.body') },
    { key: 'clubs', icon: <TrophyOutlineIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.clubs.title'), body: t('auth:guest.groups.for.clubs.body') },
    { key: 'studios', icon: <CupIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.studios.title'), body: t('auth:guest.groups.for.studios.body') },
    { key: 'neighbors', icon: <HomeIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.neighbors.title'), body: t('auth:guest.groups.for.neighbors.body') },
    { key: 'towns', icon: <NewspaperIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.towns.title'), body: t('auth:guest.groups.for.towns.body') },
  ];

  const steps = [
    { title: t('auth:guest.groups.how.say.title'), body: t('auth:guest.groups.how.say.body') },
    { title: t('auth:guest.groups.how.invite.title'), body: t('auth:guest.groups.how.invite.body') },
    { title: t('auth:guest.groups.how.change.title'), body: t('auth:guest.groups.how.change.body') },
  ];

  const points = [
    { title: t('auth:guest.groups.decides.suggest.title'), body: t('auth:guest.groups.decides.suggest.body') },
    { title: t('auth:guest.groups.decides.see.title'), body: t('auth:guest.groups.decides.see.body') },
    { title: t('auth:guest.groups.decides.configure.title'), body: t('auth:guest.groups.decides.configure.body') },
  ];

  // The four presets a community picks from (services/governance-rules.js),
  // in the Who decides dialog's order and its words. A new one starts on the
  // first.
  const rules: { key: string; icon: ReactNode; name: string; line: string }[] = [
    { key: 'you_or_the_group', icon: <UserCheckIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.you_or_the_group.name'), line: td('dialogs:whoDecides.preset.you_or_the_group.line') },
    { key: 'two_yeses', icon: <UserGroupIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.two_yeses.name'), line: td('dialogs:whoDecides.preset.two_yeses.line') },
    { key: 'open_floor', icon: <HandRaisedIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.open_floor.name'), line: td('dialogs:whoDecides.preset.open_floor.line') },
    { key: 'group_vote', icon: <BallotIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.group_vote.name'), line: td('dialogs:whoDecides.preset.group_vote.line') },
  ];

  const stages: { key: string; icon: ReactNode; title: string; body: ReactNode }[] = [
    { key: 'solo', icon: <LockIcon className="h-[22px] w-[22px]" />, title: tc('communities:sections.solo.noun'), body: t('auth:guest.groups.private.solo') },
    { key: 'invited', icon: <UserGroupIcon className="h-[22px] w-[22px]" />, title: tc('communities:sections.invited.noun'), body: t('auth:guest.groups.private.invited') },
    {
      key: 'open',
      icon: <GlobeIcon className="h-[22px] w-[22px]" />,
      title: tc('communities:sections.open.noun'),
      body: <RichMessage id="auth:guest.groups.private.open" components={[<a href="/" className={LINK} />]} />,
    },
  ];

  return (
    <div data-guest-groups="" className="flex w-full grow flex-col">
      <section className="site-band [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-4 md:pt-6 md:pb-8">
        <div className="border border-[color:var(--site-line)] bg-[var(--site-panel)]">
          <div className={STRIP} aria-hidden="true">
            <span className={`${DOT} bg-[#e8452e]`} />
            <span className={`${DOT} bg-[#f2a531]`} />
            <span className={`${DOT} bg-[#3cc23c]`} />
          </div>
          <div className="flex items-end gap-14 px-4 pt-2 md:px-10 md:pt-5">
            <div className="flex min-w-0 flex-1 flex-col items-start pb-6 md:pb-11">
              <a
                href="/"
                data-guest-groups-back=""
                className="inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-[color:var(--site-ink)] no-underline"
              >
                <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
                {t('auth:guest.groups.back')}
              </a>
              <h1 className={`mt-1.5 max-w-[640px] ${HEADLINE}`}>
                {t('auth:guest.groups.title')}
              </h1>
              <p className="mt-3.5 max-w-[620px] text-[17px] leading-[26px] text-[color:var(--site-muted)] md:mt-4 md:text-[19px] md:leading-7">
                {t('auth:guest.groups.lead')}
              </p>
              <Button
                type="button"
                variant="pillAccent"
                size="none"
                ink="solid"
                data-guest-groups-start=""
                className="mt-6 inline-flex h-12 items-center justify-center px-6 text-base font-medium"
                onClick={start}
              >
                {startLabel}
              </Button>
              <p className="mt-4 text-[15px] leading-[21px] text-[color:var(--site-muted)]">
                <RichMessage id="auth:guest.groups.publicLine" components={[<a href="/" data-guest-groups-public="" className={LINK} />]} />
              </p>
            </div>
            <img
              src="/brand/people.png"
              alt=""
              width={816}
              height={612}
              draggable={false}
              className="hidden h-auto w-[330px] shrink-0 lg:block"
            />
          </div>
        </div>
      </section>

      <section className={BAND}>
        <h2 className={HEADING}>{t('auth:guest.groups.for.heading')}</h2>
        <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g, i) => (
            <li key={g.key} className={`${CARD} flex flex-col gap-3 p-5`}>
              <div className="flex items-center gap-3">
                <span className={`${TILE} ${TILE_FILLS[i % TILE_FILLS.length]}`} aria-hidden="true">{g.icon}</span>
                <h3 className={`min-w-0 ${ROW_TITLE}`}>{g.title}</h3>
              </div>
              <p className={ROW_LINE}>{g.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={`site-band [--band:var(--site-leaf)] ${BAND}`}>
        <div className="flex flex-col gap-2.5">
          <h2 className={LABEL}>{t('auth:guest.groups.how.heading')}</h2>
          <p className={`max-w-[620px] ${HEADING}`}>{t('auth:guest.groups.how.sub')}</p>
        </div>
        <ol className="grid gap-3.5 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-[var(--site-leaf-pale)] p-6">
              <span className="text-[13px] leading-[18px] font-medium tracking-[0.05em] text-[color:var(--site-muted)]">{`0${i + 1}`}</span>
              <h3 className={ROW_TITLE}>{s.title}</h3>
              <p className={ROW_LINE}>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`site-band [--band:var(--site-sun-pale)] ${BAND}`}>
        <h2 className={HEADING}>{t('auth:guest.groups.decides.heading')}</h2>
        <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-5">
            <p className="text-[17px] leading-[26px] text-[color:var(--site-muted)] md:text-lg md:leading-[27px]">{t('auth:guest.groups.decides.lead')}</p>
            <ul data-guest-groups-points="" className={`${CARD} flex flex-col gap-4 px-5 py-[18px]`}>
              {points.map((p) => (
                <li key={p.title} className="flex items-start gap-3">
                  <span className={`mt-0.5 h-[22px] w-[22px] ${SUN_DISC}`} aria-hidden="true">
                    <CheckIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className="text-base leading-[22px] font-semibold text-[color:var(--site-ink)]">{p.title}</h3>
                    <p className="text-sm leading-5 text-[color:var(--site-muted)]">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 border border-[color:var(--site-line)] bg-[var(--site-panel)] lg:col-span-2">
            <div className={`${STRIP} bg-[var(--site-sun)]`} aria-hidden="true">
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#e8452e] md:h-2.5 md:w-2.5" />
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#f2a531] md:h-2.5 md:w-2.5" />
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#3cc23c] md:h-2.5 md:w-2.5" />
            </div>
            <ul data-guest-groups-rules="" className="flex flex-col">
              {rules.map((r, i) => (
                <li
                  key={r.key}
                  data-guest-groups-rule={r.key}
                  className={i ? 'flex items-start gap-3.5 border-t border-[color:var(--site-line)] px-5 py-4' : 'flex items-start gap-3.5 px-5 py-4'}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-mint)] text-[color:var(--site-ink)]" aria-hidden="true">{r.icon}</span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className={ROW_TITLE}>{r.name}</h3>
                      {i === 0 ? (
                        <span className="inline-flex h-[22px] items-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] px-2.5 text-xs font-semibold text-[color:var(--site-ink)]">
                          {t('auth:guest.groups.decides.default')}
                        </span>
                      ) : null}
                    </div>
                    <p className={ROW_LINE}>{r.line}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className={BAND}>
        <div className="flex flex-col gap-2.5">
          <h2 className={HEADING}>{t('auth:guest.groups.private.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.private.sub')}</p>
        </div>
        <ol data-guest-groups-stages="" className="grid gap-3.5 rounded-[14px] border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] p-4 md:grid-cols-3 md:p-5">
          {stages.map((s) => (
            <li key={s.key} className={`${CARD} flex min-w-0 flex-col gap-2.5 p-5`}>
              <span className={`h-10 w-10 ${SUN_DISC}`} aria-hidden="true">{s.icon}</span>
              <h3 className={ROW_TITLE}>{s.title}</h3>
              <p className={ROW_LINE}>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section data-guest-groups-closing="" className="site-band [--band:var(--site-sun-deep)] flex flex-col items-center gap-3 px-4 py-14 text-center md:py-[72px]">
        <h2 className={`${SERIF} text-[34px] leading-10 tracking-[-0.015em] text-[color:var(--site-ink)] text-balance md:text-[46px] md:leading-[52px]`}>{t('auth:guest.groups.closing.title')}</h2>
        <p className="max-w-[480px] text-[17px] leading-[25px] text-[color:var(--site-muted)]">{t('auth:guest.groups.closing.body')}</p>
        <button
          type="button"
          data-guest-groups-start=""
          className="mt-2.5 inline-flex h-12 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-panel)] px-6 text-base font-medium text-[color:var(--site-ink)] shadow-[0_2px_0_var(--site-line)]"
          onClick={start}
        >
          {startLabel}
        </button>
      </section>
    </div>
  );
}
