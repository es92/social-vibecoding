'use strict';

// Demo payloads for the admin Journey endpoints (#3369), served only under
// staging with ?demo=1 (src/routes/admin.js), so the dashboard and its
// preview have something to show. A staging clone has the private tables
// emptied and fixture rows reseeded, so real and invented numbers would
// otherwise sit side by side; every endpoint returns a whole demo payload
// instead, marked `demo: true`. The people are invented. Shapes follow
// src/services/journey.js exactly; tests/journey-routes.test.js pins that.

const journey = require('./journey');

const P = Object.freeze({
  mira: { userId: 900101, name: 'mira_k' },
  tobi: { userId: 900102, name: 'tobi' },
  lena: { userId: 900103, name: 'lena.s' },
  okafor: { userId: 900104, name: 'okafor' },
  jun: { userId: 900105, name: 'jun' },
  sable: { userId: 900106, name: 'sable' },
  rafa: { userId: 900107, name: 'rafa' },
});

const step = (key, state, at = null, note = null) => ({ key, state, at, note });
// The first-run list as the first mile's onboard column reads it: the tour and
// four First challenges, `done` of `total`.
const onboard = (done, total = 5) => ({ shown: true, done, total, complete: done === total });
const NO_CARD = Object.freeze({ shown: false, done: null, total: null, complete: false });

// Where somebody came from (#6540), shaped as journey.person's cameFrom.
const inviteFrom = (referrerHost, via, project, at) => ({ referrerHost, via, project, at });
const waitlistFrom = (referrerHost, utmSource, utmCampaign, ref, at) => ({ referrerHost, utmSource, utmCampaign, ref, at });
const cameFrom = (invite, waitlist) => ({ invite: invite || null, waitlist: waitlist || null });

function firstMilePerson(p, steps, extra = {}) {
  const stuck = steps.find((s) => s.state === 'stuck');
  const done = steps.filter((s) => s.state === 'done');
  return {
    signupId: null, userId: p ? p.userId : null, name: p ? p.name : 'j…@example.test', hasAccount: !!p,
    door: 'admitted', steps, furthest: done.length ? done[done.length - 1].key : null,
    stuckAt: stuck ? stuck.key : null, stuckReason: stuck ? stuck.note : null,
    daysSince: 3, failedAttempts: 0, repeatedTaps: 0, tour: null, welcome: null,
    mail: null, onboard: p ? onboard(5) : null, ...extra,
  };
}

function cohorts() {
  return {
    demo: true,
    cohorts: [
      { day: '2026-10-05', admitted: 4, withAccount: 3 },
      { day: '2026-09-24', admitted: 3, withAccount: 3 },
    ],
    otherWay: { people: 1 },
  };
}

// Everyone in a demo cohort reached every step: the earlier cohort and the
// one person who came in another way.
const allDone = (p, at, extra = {}) => firstMilePerson(p, journey.FIRST_MILE_STEPS
  .map((key) => step(key, 'done', key === 'username' ? null : at)), { daysSince: 11, ...extra });

function firstMile(day) {
  if (day === '2026-09-24') {
    const people = [
      allDone(P.okafor, '2026-09-24T10:00:00Z', { cameFrom: cameFrom(null, waitlistFrom('t.co', 'x', 'launch', null, '2026-09-22T09:00:00Z')) }),
      allDone(P.jun, '2026-09-24T10:00:00Z', { cameFrom: cameFrom(inviteFrom('discord.com', 'copied', 'Run Club', '2026-09-23T18:00:00Z')) }),
      allDone(P.sable, '2026-09-24T10:00:00Z', { cameFrom: cameFrom(null, null) }),
    ];
    return { demo: true, cohort: day, people, steps: journey.firstMileCounts(people),
      sources: journey.cohortSources(people),
      mail: journey.notRecorded('No admit mail in this cohort was tracked: tracking began on 7 Oct 2026.'),
      notRecorded: {} };
  }
  if (day === 'other_way') {
    const people = [allDone(P.rafa, '2026-09-20T10:00:00Z', {
      door: 'activation code',
      cameFrom: cameFrom(inviteFrom('web.whatsapp.com', 'shared', 'Tally', '2026-09-19T15:00:00Z')),
    })];
    people[0].steps = people[0].steps.slice(journey.FIRST_MILE_STEPS.indexOf('account'));
    return { demo: true, cohort: day, people, steps: journey.firstMileCounts(people),
      sources: journey.cohortSources(people),
      mail: journey.notRecorded('No admit mail in this cohort was tracked: tracking began on 7 Oct 2026.'),
      notRecorded: {} };
  }
  const D = '2026-10-05T09:10:00Z';
  const people = [
    firstMilePerson(P.mira, [
      step('admitted', 'done', D), step('mail_sent', 'done', D, 'clicked the link'), step('code_asked', 'done', '2026-10-05T18:31:00Z', 'its sign-in link'),
      step('account', 'done', '2026-10-05T18:32:00Z'), step('access', 'done', '2026-10-05T18:32:00Z'),
      step('opened', 'done', '2026-10-05T18:34:00Z'), step('username', 'done'),
      step('join', 'done', '2026-10-05T18:36:00Z', 'joined'),
      step('first_act', 'done', '2026-10-05T18:52:00Z', 'message'),
    ], { mail: { opened: true, clicked: true }, tour: { ended: 'finish', step: 3, at: '2026-10-05T18:40:00Z' }, onboard: onboard(3),
      cameFrom: cameFrom(inviteFrom('discord.com', 'copied', 'Pixel Garden', '2026-10-05T08:00:00Z')) }),
    firstMilePerson(P.tobi, [
      step('admitted', 'done', D), step('mail_sent', 'done', D, 'opened'), step('code_asked', 'done', '2026-10-06T07:48:00Z', 'a sign-in code'),
      step('account', 'done', '2026-10-06T07:49:00Z'), step('access', 'done', '2026-10-06T07:49:00Z'),
      step('opened', 'done', '2026-10-06T07:51:00Z'), step('username', 'done'),
      step('join', 'done', '2026-10-06T07:52:00Z', 'skipped'),
      step('first_act', 'stuck', null, 'Inside, no act yet'),
    ], { mail: { opened: true, clicked: false }, failedAttempts: 2, repeatedTaps: 1, tour: { ended: 'skip', step: 1, at: '2026-10-06T07:53:00Z' }, onboard: onboard(1),
      cameFrom: cameFrom(inviteFrom('discord.com', 'copied', 'Pixel Garden', '2026-10-05T08:10:00Z'),
        waitlistFrom('none', 'x', 'launch', null, '2026-10-05T12:00:00Z')) }),
    firstMilePerson(P.lena, [
      step('admitted', 'done', D), step('mail_sent', 'done', D, 'clicked the link'), step('code_asked', 'done', '2026-10-05T12:20:00Z', 'its sign-in link'),
      step('account', 'done', '2026-10-05T12:22:00Z'), step('access', 'done', '2026-10-05T12:22:00Z'),
      step('opened', 'done', '2026-10-05T12:25:00Z'), step('username', 'done'),
      step('join', 'stuck', null, 'Join screen shown, not answered'), step('first_act', 'not_yet'),
    ], { mail: { opened: true, clicked: true }, onboard: NO_CARD,
      cameFrom: cameFrom(inviteFrom('none', null, 'Pixel Garden', '2026-10-05T09:00:00Z')) }),
    firstMilePerson(null, [
      step('admitted', 'done', D), step('mail_sent', 'done', D, 'no open seen'),
      step('code_asked', 'stuck', null, 'Admitted, never followed the mail'),
      step('account', 'not_yet'), step('access', 'not_yet'), step('opened', 'not_yet'),
      step('username', 'not_yet'), step('join', 'not_yet'), step('first_act', 'not_yet'),
    ], { mail: { opened: false, clicked: false }, cameFrom: cameFrom(null, null) }),
  ];
  return {
    demo: true,
    cohort: day || '2026-10-05',
    people,
    steps: journey.firstMileCounts(people),
    sources: journey.cohortSources(people),
    mail: { tracked: 4, opened: 3, clicked: 2 },
    notRecorded: {},
  };
}

// The people of a demo cohort, or null for everyone.
function members(day) {
  if (!day) return null;
  return new Set(firstMile(day).people.filter((p) => p.userId).map((p) => p.userId));
}

function stages(day, all = false) {
  const ids = members(day);
  const people = [
    { ...P.mira, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: false, activateKinds: ['vote'], stoppedAt: 'stay' },
    { ...P.tobi, arrive: true, explore: false, activate: false, belong: false, use: false, stay: false, invite: false, activateKinds: [], stoppedAt: 'arrive' },
    { ...P.okafor, arrive: true, explore: true, activate: true, belong: true, use: true, stay: true, invite: false, activateKinds: ['change', 'vote'], stoppedAt: 'stay' },
    { ...P.jun, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: false, activateKinds: ['feedback', 'vote'], stoppedAt: 'stay' },
    { ...P.sable, arrive: true, explore: true, activate: true, belong: false, use: true, stay: true, invite: false, activateKinds: ['change'], stoppedAt: 'stay' },
    { ...P.rafa, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: true, activateKinds: ['vote'], stoppedAt: 'invite' },
  ].filter((p) => !ids || ids.has(p.userId));
  const counts = {};
  const stoppedAt = {};
  for (const key of journey.STAGES) {
    counts[key] = people.filter((p) => p[key]).length;
    stoppedAt[key] = people.filter((p) => p.stoppedAt === key).map((p) => ({ userId: p.userId, name: p.name }));
  }
  return { demo: true, week: all ? 'all' : '2026-09-28', finished: !all, counts, stoppedAt, people };
}

function activeGroups(day) {
  const ids = members(day);
  const keep = (g) => !ids || g.people.some((p) => ids.has(p.userId));
  const all = {
    demo: true,
    week: '2026-09-28',
    finished: true,
    count: 2,
    trend: [
      { week: '2026-08-10', count: 1 }, { week: '2026-08-17', count: 2 }, { week: '2026-08-24', count: 1 },
      { week: '2026-08-31', count: 3 }, { week: '2026-09-07', count: 2 }, { week: '2026-09-14', count: 2 },
      { week: '2026-09-21', count: 2 }, { week: '2026-09-28', count: 2 },
    ],
    groups: [
      { slug: 'trail-log', name: 'Trail Log', selfHosted: false, changes: 3, people: [P.sable, P.rafa, P.mira], active: true, lifecycle: 'new' },
      { slug: 'chore-wheel', name: 'Chore Wheel', selfHosted: false, changes: 2, people: [P.okafor, P.jun], active: true, lifecycle: 'still_active' },
    ],
    wentQuiet: [{ slug: 'supper-club', name: 'Supper Club', people: [P.lena], lifecycle: 'went_quiet' }],
    homeroom: { changes: 11, people: 19 },
    oneShort: [{ slug: 'tally', name: 'Tally', people: [P.tobi], why: 'a change is waiting for a yes from someone else', since: '2026-10-01T10:00:00Z' }],
  };
  if (!ids) return all;
  const groups = all.groups.filter(keep);
  // A cohort's trend can never be above its own count of groups in the demo.
  const trend = all.trend.map((t, i) => ({ ...t, count: i === all.trend.length - 1 ? groups.length : Math.min(t.count, groups.length) }));
  return { ...all, count: groups.length, trend, groups, wentQuiet: all.wentQuiet.filter(keep), oneShort: all.oneShort.filter(keep) };
}

function trustChecks() {
  return {
    demo: true,
    week: '2026-09-28',
    withoutGroupVote: { count: 1, of: 6, atLeastForced: 1, changes: [{ slug: 'tally', project: 'Tally', author: 'tobi', forced: true }] },
    teamShare: { team: 5, of: 11 },
    lockstep: { possible: [], cutoffs: journey.LOCKSTEP_CUTOFFS },
  };
}

function coverage() {
  return {
    demo: true, week: '2026-09-28', activePeople: 31, withNavigation: 27,
    byDay: [{ day: '2026-09-28', build: 'abc1234', rows: 412 }, { day: '2026-09-29', build: 'abc1234', rows: 388 }],
  };
}

function loops(day, allTime = false) {
  const ids = members(day);
  const all = {
    demo: true,
    change: {
      week: allTime ? 'all' : '2026-09-28',
      steps: journey.LOOP_STEPS,
      atStep: { notice: 9, make_sense: 6, sketch: 5, decide: 4, go_live: 3, hear_back: { status: 'coming' } },
      turnsClosed: { status: 'coming' },
      live: [{ project: 'Trail Log', slug: 'trail-log', number: 12, title: 'Show the elevation', reporter: P.mira,
        step: 'go_live', since: '2026-10-01T10:00:00Z', days: 6, holder: 'sable', noticedAt: '2026-09-29T10:00:00Z',
        liveAt: '2026-10-01T10:00:00Z', closed: false, daysFromNotice: 2 }],
      perProject: [{ slug: 'trail-log', project: 'Trail Log', thisWeek: 2, lastWeek: 1, alsoLastWeek: true }],
      open: [
        { project: 'Chore Wheel', slug: 'chore-wheel', number: 7, title: 'Rotate on Sundays', reporter: P.jun,
          step: 'notice', since: '2026-09-30T10:00:00Z', days: 6, holder: null, noticedAt: '2026-09-30T10:00:00Z', liveAt: null, closed: false },
        { project: 'Trail Log', slug: 'trail-log', number: 14, title: 'Dark mode', reporter: P.mira,
          step: 'sketch', since: '2026-10-03T10:00:00Z', days: 3, holder: 'sable', noticedAt: '2026-10-02T10:00:00Z', liveAt: null, closed: false },
      ],
    },
    invite: {
      steps: ['invited', 'arrived', 'did_something', 'invited_someone'],
      counts: { invited: 1, arrived: 1, did_something: 1, invited_someone: 0 },
      pairs: [{ host: P.rafa, invitee: P.sable, letInAt: '2026-10-02T09:00:00Z', arrived: true, didSomething: true, invitedSomeone: false }],
    },
  };
  if (!ids) return all;
  // Narrowed the way journey.changeLoop and journey.inviteLoop narrow.
  const mine = (t) => t.reporter && ids.has(t.reporter.userId);
  const open = all.change.open.filter(mine);
  const live = all.change.live.filter(mine);
  const atStep = {};
  for (const key of journey.LOOP_STEPS) {
    atStep[key] = key === 'hear_back' ? { status: 'coming' }
      : key === 'go_live' ? live.length : open.filter((t) => t.step === key).length;
  }
  const pairs = all.invite.pairs.filter((x) => ids.has(x.host.userId) || ids.has(x.invitee.userId));
  return {
    ...all,
    change: { ...all.change, open, live, atStep, perProject: all.change.perProject.filter((p) => live.some((t) => t.slug === p.slug)) },
    invite: { ...all.invite, pairs, counts: {
      invited: pairs.length, arrived: pairs.filter((x) => x.arrived).length,
      did_something: pairs.filter((x) => x.didSomething).length, invited_someone: pairs.filter((x) => x.invitedSomeone).length,
    } },
  };
}

function nextSteps() {
  return {
    demo: true,
    people: 6,
    leftOut: { droppedEvents: [], noNavigation: [] },
    starts: [{ screen: 'home', visits: 38, people: 6 }, { screen: 'messages', visits: 9, people: 4 }],
    rows: [
      { screen: 'home', moves: 41, people: 6, next: [{ to: 'discover', moves: 15, people: 5 }, { to: 'app', moves: 11, people: 5 }, { to: 'messages', moves: 6, people: 4 }], other: 4, left: { moves: 5, people: 3 }, deadEnd: false, few: false },
      { screen: 'discover', moves: 18, people: 5, next: [{ to: 'app', moves: 6, people: 4 }, { to: 'home', moves: 4, people: 3 }], other: 0, left: { moves: 8, people: 4 }, deadEnd: true, few: false },
      { screen: 'profile', moves: 4, people: 2, next: [{ to: 'back', moves: 3, people: 2 }], other: 0, left: { moves: 1, people: 1 }, deadEnd: true, few: true },
    ],
  };
}

function person(userId) {
  return {
    demo: true,
    userId: Number(userId) || P.tobi.userId,
    name: P.tobi.name,
    cohort: '2026-10-05',
    firstMile: firstMile().people[1],
    cameFrom: cameFrom(inviteFrom('discord.com', 'copied', 'Pixel Garden', '2026-10-05T08:10:00Z'),
      waitlistFrom('none', 'x', 'launch', null, '2026-10-05T12:00:00Z')),
    found: [],
    cameBackTo: [],
    usedOftenNotOnHome: [],
    waysIn: { address: 1 },
    visits: 1,
    possiblyLost: [{
      at: '2026-10-06T07:53:00Z',
      path: ['home', 'discover', 'home', 'communities', 'home', 'messages', 'home', 'discover', 'app:tally', 'discover', 'home', 'profile', 'home'],
      possiblyLost: true, steps: 13, distinct: 7, seconds: 50, secondsPerStep: 3.8, repeatShare: 0.46, landed: false,
      cutoffs: journey.LOST_CUTOFFS,
    }],
    failedAttempts: 2,
    repeatedTaps: 1,
    challenges: { openedAt: null, credits: [] },
    navigation: { recorded: true },
    made: DEMO_PROJECTS.filter((p) => p.userId === P.tobi.userId).map((p) => ({
      slug: p.slug, project: p.project, createdAt: p.createdAt, asked: p.asked, template: p.template, firstVersion: p.firstVersion,
    })),
    madeScreen: DEMO_MADE_SCREENS.filter(([p]) => p.userId === P.tobi.userId).flatMap(([, at, list]) => list.map((m, i) => {
      const [kind, detail] = Array.isArray(m) ? m : [m, {}];
      return { kind, at: new Date(Date.parse(at) + 60000 + i * 20000).toISOString(), ...detail };
    })),
  };
}

// "All time" in the demo: the same headline week, with sixteen weeks of trend.
const EARLIER_TREND = [0, 0, 1, 1, 0, 1, 2, 1].map((count, i) => ({
  week: new Date(Date.UTC(2026, 5, 15 + i * 7)).toISOString().slice(0, 10), count,
}));

function summary(day, all = false) {
  const mile = firstMile(day === 'other_way' || day === '2026-09-24' ? day : undefined);
  const groups = activeGroups(day);
  return {
    demo: true,
    week: '2026-09-28',
    allTime: all,
    thisWeekSoFar: { week: '2026-10-05', count: 1 },
    groups: all ? { ...groups, trend: [...EARLIER_TREND.map((t) => ({ ...t, count: Math.min(t.count, groups.count) })), ...groups.trend] } : groups,
    stuck: mile.people.filter((p) => p.stuckAt).map((p) => ({
      userId: p.userId, name: p.name, cohort: mile.cohort, stuckAt: p.stuckAt, reason: p.stuckReason,
      days: p.daysSince, failedAttempts: p.failedAttempts,
    })),
    openTurns: loops(day).change.open,
    trust: trustChecks(),
    coverage: coverage(),
  };
}

function leftOut() {
  return { demo: true, people: [{ userId: 900199, username: 'qa_phone', reason: 'test', note: 'QA phone', addedBy: 'admin', addedAt: '2026-10-02T10:00:00Z' }] };
}

// ── Creation path and pairs ────────────────────────────────────────────
//
// Eight demo weeks, 10 Aug to 28 Sep, read the way journey.creationPath and
// journey.pairs read the real rows (their own step and week arithmetic), so
// a cohort narrows the demo exactly as it narrows the real page. Running,
// Preview opened and Requested change live are recorded from 22 Sep in the
// demo, so the weeks before show "not recorded".

const DEMO_WEEK = '2026-09-28';
const DEMO_RECORDED_FROM = '2026-09-22T09:00:00Z';
const DEMO_WEEKS = Array.from({ length: journey.TREND_WEEKS }, (_, i) => {
  const start = new Date(Date.UTC(2026, 7, 10 + i * 7));
  return { start, end: new Date(start.getTime() + journey.WEEK_MS), label: start.toISOString().slice(0, 10) };
});

// Where the time to running went (#4895), for the projects that ran since
// creation was timed: the record services/app-creation-timing.js writes,
// read back the way journey.creationTiming reads a real one.
const demoTimed = (totalMs, stages, build, pod) => journey.creationTiming({
  outcome: 'running', kind: 'new_repo', totalMs, stages: { lock: 10, manifest: 300, checkout: 250, card: 20, ...stages }, build, pod,
});
const BUILDKIT_STEPS = [
  { name: 'exporting cache to registry', ms: 19000 },
  { name: '[css 3/7] RUN npm ci --include=dev', ms: 16000 },
  { name: 'exporting to image', ms: 11000 },
];
const DEMO_TIMING = {
  pantry: demoTimed(95000, { database: 1100, repository: 4300, build: 70000, deploy: 800, rollout: 18300 },
    { engine: 'kpack', phases: [{ name: 'build', ms: 31000 }, { name: 'export', ms: 17000 }, { name: 'restore', ms: 9000 }] },
    { scheduleMs: 1000, startMs: 12000, readyMs: 5000 }),
  'run-club': demoTimed(118000, { database: 900, repository: 5200, build: 92000, deploy: 700, rollout: 18600 },
    { engine: 'kpack', phases: [{ name: 'build', ms: 44000 }, { name: 'export', ms: 21000 }, { name: 'restore', ms: 12000 }] },
    { scheduleMs: 1000, startMs: 13000, readyMs: 4000 }),
  'reading-pile': demoTimed(90000, { database: 1000, repository: 4100, build: 66000, deploy: 600, rollout: 17800 },
    { engine: 'buildkit', steps: BUILDKIT_STEPS }, { scheduleMs: 1000, startMs: 12000, readyMs: 4000 }),
  'bird-log': demoTimed(94000, { database: 1200, repository: 4600, build: 69000, deploy: 700, rollout: 18100 },
    { engine: 'buildkit', steps: BUILDKIT_STEPS }, { scheduleMs: 1000, startMs: 13000, readyMs: 4000 }),
  tally: demoTimed(101000, { database: 1000, repository: 6900, build: 73000, deploy: 800, rollout: 19500 },
    { engine: 'buildkit', steps: BUILDKIT_STEPS }, { scheduleMs: 2000, startMs: 13000, readyMs: 4000 }),
  'book-swap': demoTimed(87000, { database: 900, repository: 3900, build: 64000, deploy: 600, rollout: 17200 },
    { engine: 'buildkit', steps: BUILDKIT_STEPS }, { scheduleMs: 1000, startMs: 12000, readyMs: 4000 }),
};

// What each demo project's maker asked for, as the page shows it.
const DEMO_ASKED = {
  pantry: 'Track what is in the shared pantry and who is bringing what to the next potluck.',
  'run-club': 'Plan our Saturday runs: the route, who is coming, and a pace for each group.',
  'reading-pile': 'A list of books our club wants to read, where anyone can add a title and vote on the next one.',
  'bird-log': 'Log the birds we see on our morning walks, with the place, and a count for the week.',
  tally: 'Keep score for our board game nights, with a running total for each of us over the season.',
  'book-swap': 'Neighbours list the books they are happy to lend, and anyone can ask to borrow one.',
};

// Each demo first version, read the way journey.firstVersionOf reads a real
// one: [seconds from Make it to each stage reached, in pipeline order],
// how its filing and latest run ended, and its maker around its going live
// (active within the window, and seconds until they opened it after).
const FV_PIPELINE = [
  'plan_written', 'go_ahead', 'picked_up', 'spec_started', 'first_look_saved', 'build_started',
  'build_done', 'review_round', 'testing_started', 'merged', 'live',
];
const DEMO_FIRST_VERSIONS = {
  pantry: { secs: [18, 80, 95, 100, 170, 180], failed: false },
  'run-club': { secs: [22, 140, 160, 165, 230, 240], failed: true },
  'reading-pile': { secs: [20, 95, 110, 115, 190, 200, 520, 530, 700, 900, 960], nearLive: true, back: 40 },
  'bird-log': { secs: [25, 300, 320, 330, 410, 420, 760, 770, 950, 1150, 1230], nearLive: false, back: 7200 },
  tally: { secs: [24], failed: false },
  'book-swap': { secs: [19, 60, 70, 75, 140, 150, 480, 490, 650, 840, 900], nearLive: true, back: 15 },
};
const DEMO_NOW = new Date('2026-10-05T00:00:00Z');

function demoFirstVersion(slug, createdAt) {
  const fv = DEMO_FIRST_VERSIONS[slug];
  if (!fv) return null;
  const at = (sec) => new Date(Date.parse(createdAt) + sec * 1000).toISOString();
  const stages = Object.fromEntries(fv.secs.map((sec, i) => [FV_PIPELINE[i], at(sec)]));
  const liveSec = fv.secs.length === FV_PIPELINE.length ? fv.secs[fv.secs.length - 1] : null;
  return journey.firstVersionOf({
    bot_builds: true, created_at: createdAt, stages, filing: 'filed', run_failed: !!fv.failed,
    near_live: liveSec != null ? !!fv.nearLive : null,
    back_at: liveSec != null && fv.back != null ? at(liveSec + fv.back) : null,
  }, DEMO_NOW, { stagesFrom: DEMO_RECORDED_FROM });
}

// [person, slug, project, created at, seconds to running, first version,
// preview opened, requested change live]; null is not reached.
const DEMO_PROJECTS = [
  [P.okafor, 'seed-swap', 'Seed Swap', '2026-08-12T10:00:00Z', null, 150, null, null],
  [P.jun, 'tide-times', 'Tide Times', '2026-08-26T15:00:00Z', null, 210, null, null],
  [P.sable, 'trail-log', 'Trail Log', '2026-09-02T09:30:00Z', null, 175, null, null],
  [P.rafa, 'gear-list', 'Gear List', '2026-09-09T19:00:00Z', null, null, null, null],
  [P.okafor, 'chore-wheel', 'Chore Wheel', '2026-09-16T08:00:00Z', null, 125, null, null],
  [P.sable, 'bird-count', 'Bird Count', '2026-09-21T11:00:00Z', null, 140, null, null],
  [P.jun, 'pantry', 'Pantry', '2026-09-24T12:00:00Z', 97, 160, 410, null],
  [P.rafa, 'run-club', 'Run Club', '2026-09-28T09:00:00Z', 120, null, null, null],
  [P.jun, 'reading-pile', 'Reading Pile', '2026-09-29T08:00:00Z', 91, 160, 330, null],
  [P.okafor, 'bird-log', 'Bird Log', '2026-09-29T17:00:00Z', 95, 118, 205, null],
  [P.tobi, 'tally', 'Tally', '2026-09-30T09:00:00Z', 102, null, null, null],
  [P.mira, 'book-swap', 'Book Swap', '2026-10-01T18:00:00Z', 88, 131, 240, 770],
].map(([p, slug, project, createdAt, running, firstVersion, preview, changeLive]) => {
  const recorded = Date.parse(createdAt) >= Date.parse(DEMO_RECORDED_FROM);
  const ev = (seconds) => ({ counted: recorded || seconds != null, seconds });
  return {
    appId: 0, slug, project, userId: p.userId, name: p.name, createdAt,
    steps: {
      created: { counted: true, seconds: 0 },
      running: ev(running),
      first_version: { counted: true, seconds: firstVersion },
      preview: ev(preview),
      change_live: ev(changeLive),
    },
    timing: DEMO_TIMING[slug] || null,
    asked: DEMO_ASKED[slug] || null,
    template: null,
    firstVersion: demoFirstVersion(slug, createdAt),
  };
});

const inDemoSpan = (iso, span) => Date.parse(iso) >= span.start.getTime() && Date.parse(iso) < span.end.getTime();
const demoWindow = (all) => (all
  ? { start: new Date('2020-01-01T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z') }
  : DEMO_WEEKS[DEMO_WEEKS.length - 1]);

function creation(day, all = false) {
  const ids = members(day);
  const projects = DEMO_PROJECTS.filter((p) => !ids || ids.has(p.userId));
  const window = demoWindow(all);
  const inWeek = projects.filter((p) => inDemoSpan(p.createdAt, window));
  return {
    demo: true,
    week: all ? 'all' : DEMO_WEEK,
    finished: !all,
    steps: journey.creationSteps(inWeek),
    targets: journey.CREATION_TARGETS,
    recordedFrom: { running: DEMO_RECORDED_FROM, preview: DEMO_RECORDED_FROM, change_live: DEMO_RECORDED_FROM },
    weeks: DEMO_WEEKS.map((w) => ({
      week: w.label,
      steps: journey.creationSteps(projects.filter((p) => inDemoSpan(p.createdAt, w)))
        .map((s) => ({ key: s.key, reached: s.reached, medianSeconds: s.medianSeconds })),
    })),
    timing: { from: DEMO_RECORDED_FROM, ...journey.creationTimingSummary(inWeek) },
    firstVersion: { from: DEMO_RECORDED_FROM, ...journey.firstVersionSummary(inWeek, { recordedFrom: DEMO_RECORDED_FROM }) },
    examples: [...inWeek].reverse().slice(0, 6).map((p) => ({
      userId: p.userId, name: p.name, slug: p.slug, project: p.project, createdAt: p.createdAt,
      steps: journey.CREATION_STEPS.filter((key) => key !== 'created')
        .map((key) => ({ key, recorded: p.steps[key].counted, seconds: p.steps[key].seconds })),
      timing: p.timing,
      asked: p.asked,
      template: p.template,
      firstVersion: p.firstVersion ? { recorded: p.firstVersion.recorded, outcome: p.firstVersion.outcome, last: p.firstVersion.last } : null,
    })),
  };
}

// [project slug, name, the pair, via, the second joined at, hours until both
// were active (null: not both), still inside its 7 days].
const DEMO_PAIRS = [
  ['seed-swap', 'Seed Swap', [P.okafor, P.jun], 'members', '2026-08-14T10:00:00Z', null, false],
  ['tide-times', 'Tide Times', [P.jun, P.sable], 'invite', '2026-08-19T10:00:00Z', 30, false],
  ['gear-list', 'Gear List', [P.rafa, P.mira], 'members', '2026-08-27T10:00:00Z', null, false],
  ['trail-log', 'Trail Log', [P.sable, P.okafor], 'invite', '2026-09-03T10:00:00Z', 6, false],
  ['bird-count', 'Bird Count', [P.sable, P.lena], 'members', '2026-09-04T10:00:00Z', null, false],
  ['chore-wheel', 'Chore Wheel', [P.okafor, P.jun], 'invite', '2026-09-10T10:00:00Z', 44, false],
  ['pantry', 'Pantry', [P.jun, P.tobi], 'members', '2026-09-17T10:00:00Z', 70, false],
  ['run-club', 'Run Club', [P.rafa, P.sable], 'invite', '2026-09-23T10:00:00Z', 18, false],
  ['reading-pile', 'Reading Pile', [P.jun, P.lena], 'members', '2026-09-24T10:00:00Z', null, false],
  ['bird-log', 'Bird Log', [P.okafor, P.sable], 'invite', '2026-09-29T20:00:00Z', 20, false],
  ['tally', 'Tally', [P.tobi, P.lena], 'members', '2026-09-30T10:00:00Z', null, false],
  ['book-swap', 'Book Swap', [P.mira, P.tobi], 'invite', '2026-10-01T19:00:00Z', 26, false],
  ['tide-chart', 'Tide Chart', [P.jun, P.mira], 'members', '2026-10-03T08:00:00Z', null, true],
].map(([slug, name, pair, via, secondJoinedAt, hoursToBoth, open]) => ({
  slug, name, pair, via, secondJoinedAt, bothActive: hoursToBoth != null, hoursToBoth, open,
}));

function pairs(day, all = false) {
  const ids = members(day);
  const list = DEMO_PAIRS.filter((p) => !ids || p.pair.some((x) => ids.has(x.userId)));
  const window = demoWindow(all);
  const inWeek = list.filter((p) => inDemoSpan(p.secondJoinedAt, window));
  return {
    demo: true,
    week: all ? 'all' : DEMO_WEEK,
    finished: !all,
    days: journey.PAIR_DAYS,
    count: inWeek.filter((p) => p.bothActive).length,
    of: inWeek.length,
    open: inWeek.filter((p) => p.open).length,
    trend: DEMO_WEEKS.map((w) => {
      const span = list.filter((p) => inDemoSpan(p.secondJoinedAt, w));
      return { week: w.label, count: span.filter((p) => p.bothActive).length, of: span.length };
    }),
    examples: [...inWeek].reverse().slice(0, 6),
  };
}

// ── First session ──────────────────────────────────────────────────────
//
// Rows shaped as journey.FIRST_SESSION_SQL returns them, read by the real
// journey.firstSessionReading. [path, person, slug, project, started at,
// seconds to sketch shown / invite sent / running (make), to first
// message / first request (join), or to a project of their own after
// "Look around first" (look)]; null is not reached.
const DEMO_FIRST_SESSIONS = [
  ['make', P.jun, 'reading-pile', 'Reading Pile', '2026-09-29T08:00:00Z', [38, 410, 91]],
  ['make', P.okafor, 'bird-log', 'Bird Log', '2026-09-29T17:00:00Z', [44, 1900, 95]],
  ['make', P.tobi, 'tally', 'Tally', '2026-09-30T09:00:00Z', [170, null, 102]],
  ['make', P.mira, 'book-swap', 'Book Swap', '2026-10-01T18:00:00Z', [41, 260, 88]],
  ['join', P.sable, 'bird-log', 'Bird Log', '2026-09-29T20:00:00Z', [95, 1300]],
  ['join', P.lena, 'tally', 'Tally', '2026-09-30T12:00:00Z', [null, null]],
  ['join', P.tobi, 'book-swap', 'Book Swap', '2026-10-01T19:00:00Z', [130, null]],
  ['look', P.rafa, null, null, '2026-09-30T15:00:00Z', [5400]],
  ['look', P.sable, null, null, '2026-10-02T08:00:00Z', [null]],
].map(([path, p, slug, name, at, secs]) => {
  const plus = (s) => (s == null ? null : new Date(Date.parse(at) + s * 1000).toISOString());
  const row = {
    path, user_id: p.userId, username: p.name, slug, name, intent_at: at,
    reward_at: null, invited_at: null, running_at: null, said_at: null, suggested_at: null, made_at: null,
    brief: path === 'make' ? DEMO_ASKED[slug] || null : null, template: null,
  };
  if (path === 'make') return { ...row, reward_at: plus(secs[0]), invited_at: plus(secs[1]), running_at: plus(secs[2]) };
  if (path === 'join') return { ...row, said_at: plus(secs[0]), suggested_at: plus(secs[1]) };
  return { ...row, made_at: plus(secs[0]) };
});

// Each demo maker's made screen and tour, as journey.MADE_SCREEN_SQL
// returns its rows: [person, when it opened, moments in order], a moment
// being its kind, or [kind, detail].
const TOUR_CARDS = 6;
const tourCards = (n) => Array.from({ length: n }, (_, i) => ['tour_step_shown', { step: i + 1, steps: TOUR_CARDS }]);
const DEMO_MADE_SCREENS = [
  [P.jun, '2026-09-29T08:00:00Z', ['made_shown', 'questions_shown', 'submit_tapped', 'invite_shown', 'share_invite_tapped',
    ['invite_sent', { how: 'shared' }], 'continue_tapped', ['tour_started', { steps: TOUR_CARDS }], ...tourCards(6),
    ['tour_ended', { step: 6, steps: TOUR_CARDS, how: 'done' }]]],
  [P.okafor, '2026-09-29T17:00:00Z', ['made_shown', 'questions_shown', 'submit_tapped', 'invite_shown', 'invite_later_tapped',
    'continue_tapped', ['tour_started', { steps: TOUR_CARDS }], ...tourCards(3), ['tour_ended', { step: 3, steps: TOUR_CARDS, how: 'skipped' }]]],
  [P.tobi, '2026-09-30T09:00:00Z', ['made_shown', 'questions_shown']],
  [P.mira, '2026-10-01T18:00:00Z', ['made_shown', 'invite_shown', 'share_invite_tapped', ['invite_sent', { how: 'copied' }],
    'continue_tapped', ['tour_started', { steps: TOUR_CARDS }], ...tourCards(2)]],
];
const madeRows = (p, moments) => moments.map((m) => {
  const [kind, detail] = Array.isArray(m) ? m : [m, {}];
  return { user_id: p.userId, kind, how: detail.how || null, step: detail.step ?? null, steps: detail.steps ?? null };
});

function firstSession(day, all = false) {
  const ids = members(day);
  const window = demoWindow(all);
  const rows = DEMO_FIRST_SESSIONS
    .filter((r) => !ids || ids.has(r.user_id))
    .filter((r) => inDemoSpan(r.intent_at, window));
  const week = all
    ? { label: 'all', finished: false }
    : { label: DEMO_WEEK, finished: true };
  // The invite funnel, shaped as journey.INVITE_FUNNEL_SQL returns it. The
  // week's joins are its first sessions' (everyone's: a cohort has none).
  // Its sign-ins in their two ways: from the link, and already signed in.
  const joined = DEMO_FIRST_SESSIONS.filter((r) => r.path === 'join' && inDemoSpan(r.intent_at, window)).length;
  const opens = journey.inviteFunnelReading(
    {
      since: DEMO_RECORDED_FROM, opened: all ? 26 : 11,
      signed_in: all ? 12 : 5, signed_in_by_invite: all ? 8 : 3, signed_in_already: all ? 4 : 2,
      joined: all ? 7 : joined,
      landed_since: DEMO_RECORDED_FROM,
      landed_card: all ? 23 : 10, landed_dead: all ? 1 : 0, landed_failed: 0, landed_timeout: all ? 2 : 1,
    },
    { week: window, cohort: !!ids },
  );
  const moments = DEMO_MADE_SCREENS
    .filter(([p, at]) => (!ids || ids.has(p.userId)) && inDemoSpan(at, window))
    .flatMap(([p, , list]) => madeRows(p, list));
  return {
    demo: true,
    ...journey.firstSessionReading(rows, opens, {
      week,
      recordedFrom: {
        make: DEMO_RECORDED_FROM, reward: DEMO_RECORDED_FROM, opens: DEMO_RECORDED_FROM, signedIn: DEMO_RECORDED_FROM, look: DEMO_RECORDED_FROM,
      },
    }),
    made: journey.madeScreenReading(moments, { week: window, recordedFrom: DEMO_RECORDED_FROM }),
  };
}

module.exports = {
  cohorts, firstMile, stages, activeGroups, trustChecks, coverage, loops, nextSteps, person, summary, leftOut,
  creation, pairs, firstSession,
};
