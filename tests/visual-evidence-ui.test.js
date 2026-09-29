'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AppView = require('../public/js/app-view.js');

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/evidence/${id(char)}`;

function evidence(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog',
      claim: 'Typing shows <matching> users & keeps "Invite" visible.',
      persona: 'member',
      viewports: ['desktop'],
      steps: ['Open <Members>', 'Type ma'],
      baseState: 'present',
      animation: 'steps',
    }],
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), planHash: 'c'.repeat(64),
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: null,
    artifacts: [
      { id: id('1'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'focus', media: 'png', url: url('1') },
      { id: id('2'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: url('2') },
      { id: id('3'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('3') },
      { id: id('4'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('4') },
      // A server bug or injected object cannot turn an absolute URL into media.
      { id: id('6'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: 'https://evil.example/x.png' },
    ],
    ...overrides,
  };
}

// A run from before shots: one paired before/after recording per viewport.
function legacyPaired() {
  return { id: id('5'), storyId: 'dialog', viewport: 'desktop', side: 'paired', variant: 'animation', media: 'webm', url: url('5') };
}

function clipArtifacts(storyId = 'dialog') {
  return [
    { id: id('7'), storyId, viewport: 'desktop', side: 'base', variant: 'animation', media: 'webm', url: url('7') },
    { id: id('8'), storyId, viewport: 'desktop', side: 'head', variant: 'animation', media: 'webm', url: url('8') },
  ];
}

test('verified cards lead with the declared change, escaped, authenticated, and never autoplay', () => {
  const value = evidence();
  value.artifacts.push(legacyPaired());
  const html = AppView.visualEvidenceHtml(value, { sessionId: 42 });
  assert.match(html, /Typing shows &lt;matching&gt; users &amp; keeps &quot;Invite&quot; visible/);
  assert.doesNotMatch(html, /<matching>|evil\.example|\/visuals\//);
  assert.ok(html.indexOf('Typing shows') < html.indexOf('<img src='), 'the declared change precedes the shots');
  assert.match(html, /aria-label="Before\/after shots"/);
  assert.match(html, /<video[^>]* controls[^>]*preload="none"[^>]* muted[^>]*playsinline/);
  assert.doesNotMatch(html, /<video[^>]*\bautoplay\b/);
  assert.match(html, /before <code>aaaaaaaa<\/code>/);
  assert.match(html, /after <code>bbbbbbbb<\/code>/);
  assert.match(html, /shots <code>cccccccccccc<\/code>/);
  assert.match(html, /Shots ready/);
  assert.match(html, /Shot details/);
  assert.match(html, /taken by the preview agent/);
  assert.match(html, /Open full screen/);
  assert.match(html, /Look at the shots and clips to decide whether they show the change\./);
  // The retired replay vocabulary is gone.
  assert.doesNotMatch(html, /Visual change preview|clean replays|bounded repair|relative-pointer|Captured/);
});

test('a legacy paired recording still plays, labelled by what the change declared', () => {
  const steps = evidence();
  steps.artifacts.push(legacyPaired());
  const interaction = AppView.visualEvidenceHtml(steps, { sessionId: 42 });
  assert.match(interaction, /Play interaction/);
  assert.match(interaction, new RegExp(`<video src="${url('5')}"`));
  assert.doesNotMatch(interaction, /data-evidence-clips/);

  const motion = evidence();
  motion.claims[0].animation = 'motion';
  motion.artifacts.push(legacyPaired());
  const html = AppView.visualEvidenceHtml(motion, { sessionId: 42 });
  assert.match(html, /Play animation/);
  assert.doesNotMatch(html, /Play interaction/);
});

test('a motion change with a clip per side shows a before and an after player', () => {
  const value = evidence();
  value.claims[0].animation = 'motion';
  value.artifacts.push(...clipArtifacts());
  const html = AppView.visualEvidenceHtml(value, { sessionId: 42 });
  const clips = /<div data-evidence-clips="1"[^>]*>([\s\S]*?)<\/div>\s*<div class="mt-2 flex/.exec(html);
  assert.ok(clips, 'the clips sit in their own block');
  const players = clips[1].match(/<video [^>]*>/g) || [];
  assert.equal(players.length, 2);
  assert.match(players[0], new RegExp(`src="${url('7')}"`));
  assert.match(players[0], new RegExp(`poster="${url('3')}"`), 'the before screen shot is the before poster');
  assert.match(players[1], new RegExp(`src="${url('8')}"`));
  assert.match(players[1], new RegExp(`poster="${url('4')}"`));
  for (const player of players) {
    assert.match(player, / controls preload="none" muted playsinline/);
    assert.doesNotMatch(player, /\bautoplay\b/);
  }
  assert.match(clips[1], /Before clip/);
  assert.match(clips[1], /After clip/);
  // Side-by-side clips replace the legacy paired player.
  assert.doesNotMatch(html, /Play animation|Play interaction/);
  assert.match(html, /Look at the shots and clips/);

  // A clip missing on one side says so rather than hiding the other.
  const oneSided = evidence();
  oneSided.claims[0].animation = 'motion';
  oneSided.artifacts.push(clipArtifacts()[1]);
  const partial = AppView.visualEvidenceHtml(oneSided, { sessionId: 42 });
  assert.match(partial, /data-evidence-clips="1"/);
  assert.match(partial, /No clip/);
  assert.equal((partial.match(/<video /g) || []).length, 1);

  // A clip URL for another proposal is never played.
  const foreign = evidence();
  foreign.claims[0].animation = 'motion';
  foreign.artifacts.push(...clipArtifacts().map((clip) => ({ ...clip, url: clip.url.replace('/42/', '/43/') })));
  assert.doesNotMatch(AppView.visualEvidenceHtml(foreign, { sessionId: 42 }), /<video|data-evidence-clips/);
});

test('the element shot leads over the screen shot, and full screen opens the screen shots', () => {
  const html = AppView.visualEvidenceHtml(evidence(), { sessionId: 42 });
  const images = [...html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(images, [url('1'), url('2')]);
  assert.match(html, new RegExp(`data-before-url="${url('3')}" data-head-url="${url('4')}"`));

  // Without an element shot the screen shot stands in.
  const screens = evidence({ artifacts: evidence().artifacts.filter((artifact) => artifact.variant === 'context') });
  const fallback = AppView.visualEvidenceHtml(screens, { sessionId: 42 });
  assert.deepEqual([...fallback.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('3'), url('4')]);
});

test('a privileged declared change is explicitly labelled as full admin', () => {
  const value = evidence();
  value.claims[0].persona = 'full_admin';
  const html = AppView.visualEvidenceHtml(value, { sessionId: 42 });
  assert.match(html, /desktop · full admin/);
});

test('a still change shows before and after PNGs without suggesting a video', () => {
  const value = evidence();
  value.claims[0].animation = 'none';
  const html = AppView.visualEvidenceHtml(value, { sessionId: 42 });
  assert.match(html, /Look at the shots to decide whether they show the change\./);
  assert.match(html, /<img src=/);
  assert.doesNotMatch(html, /<video|Play interaction|Play animation|shots and clips|data-evidence-clips/);
});

test('absence is labelled only when the author explicitly declared a new before state', () => {
  const withoutBase = evidence({ artifacts: evidence().artifacts.filter((a) => a.side !== 'base') });
  const ordinary = AppView.visualEvidenceHtml(withoutBase, { sessionId: 42 });
  assert.match(ordinary, /No shot/);
  assert.doesNotMatch(ordinary, /Not there yet/);

  withoutBase.claims = [{ ...withoutBase.claims[0], baseState: 'not_present' }];
  const absent = AppView.visualEvidenceHtml(withoutBase, { sessionId: 42 });
  assert.match(absent, /Before · Not there yet/);
});

test('a skipped change shows its reason and no media, beside a ready one', () => {
  const value = evidence({
    claims: [
      { ...evidence().claims[0], animation: 'none' },
      { id: 'empty', claim: 'An empty <search> says no users match.', persona: 'member',
        viewports: ['desktop'], steps: ['Type zz'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [
      { id: 'dialog', status: 'ready', reason: null },
      { id: 'empty', status: 'skipped', reason: 'The member fixture has no <list> to search.' },
    ],
    // A run may publish only the screen shots; thumbnails use them.
    artifacts: evidence().artifacts.filter((artifact) => artifact.variant === 'context'),
  });
  const html = AppView.visualEvidenceHtml(value, { sessionId: 42 });
  const skipped = /<article data-evidence-story="empty" data-evidence-shot-status="skipped"[\s\S]*?<\/article>/.exec(html);
  assert.ok(skipped, 'the skipped change is marked');
  assert.match(skipped[0], /An empty &lt;search&gt; says no users match\./);
  assert.match(skipped[0], />Skipped</);
  assert.match(skipped[0], /The member fixture has no &lt;list&gt; to search\./);
  assert.doesNotMatch(skipped[0], /<img|<video|Open full screen|Shots ready/);
  assert.match(html, new RegExp(`<img src="${url('3')}"`), 'the ready change still shows its shots');
  assert.match(html, new RegExp(`<img src="${url('4')}"`));
  assert.doesNotMatch(html, /data-evidence-story="dialog" data-evidence-shot-status/);

  const unexplained = AppView.visualEvidenceHtml({
    ...value, shotResults: [value.shotResults[0], { id: 'empty', status: 'skipped', reason: null }],
  }, { sessionId: 42 });
  assert.match(unexplained, /The preview agent could not get to this change\./);

  const summary = AppView._workshopVisuals(null, {
    ...value,
    claims: [value.claims[1], value.claims[0]],
  });
  assert.equal(summary.claim, value.claims[0].claim, 'the feed skips a change with no shots');
  assert.equal(summary.before, url('3'));
  assert.equal(summary.after, url('4'));
});

test('pending or failed shots show the declared changes and status but no media or legacy fallback', () => {
  for (const state of ['planned', 'failed', 'stale']) {
    const html = AppView.visualEvidenceHtml(evidence({
      state,
      failureReason: state === 'failed' ? 'The dialog could not be reached.' : null,
      repairAvailable: state === 'failed',
    }), { sessionId: 42 });
    assert.match(html, new RegExp(`data-evidence-state="${state}"`));
    assert.doesNotMatch(html, /<img|<video|\/visuals\//);
    assert.match(html, /<li>Typing shows &lt;matching&gt;/);
  }
  assert.equal(AppView._workshopVisuals({ after: { png: id('a') } }, evidence({ state: 'failed' })), null);
});

test('the workshop summary uses protected element shots only after verification', () => {
  const summary = AppView._workshopVisuals(null, evidence());
  assert.equal(summary.protected, true);
  assert.equal(summary.before, url('1'));
  assert.equal(summary.after, url('2'));
  assert.equal(summary.claim, evidence().claims[0].claim);
});

test('running shots offer Stop, and a stopped or failed set offers to take them again', () => {
  const running = AppView.visualEvidenceHtml(evidence({ state: 'exploring', artifacts: [] }), { sessionId: 42 });
  assert.match(running, /Taking the shots/);
  assert.match(running, /data-evidence-stop="1"[^>]*onclick="AppView\.stopVisualEvidence\(42, this\)">Stop</);
  assert.match(AppView.visualEvidenceHtml(evidence({ state: 'provisioning', artifacts: [] }), { sessionId: 42 }),
    /Building before and after/);
  assert.match(AppView.visualEvidenceHtml(evidence({ state: 'reviewing', artifacts: [] }), { sessionId: 42 }),
    /Saving the shots/);
  const notStarted = AppView.visualEvidenceHtml(evidence({ state: 'planned', artifacts: [] }), { sessionId: 42 });
  assert.doesNotMatch(notStarted, /data-evidence-stop/, 'nothing is running to stop');

  const stopped = AppView.visualEvidenceHtml(evidence({
    state: 'failed', artifacts: [], failureCode: 'evidence_stopped', repairAvailable: false,
    failureReason: 'Stopped before it finished.',
  }), { sessionId: 42 });
  assert.match(stopped, /Shots stopped/);
  assert.doesNotMatch(stopped, /bg-red-500\/10/, 'a stop is not a failure');
  assert.match(stopped, /onclick="AppView\.rerunVisualEvidence\(42, this\)">Take the shots again</);
  assert.doesNotMatch(stopped, /data-evidence-stop/);

  const failed = AppView.visualEvidenceHtml(evidence({
    state: 'failed', artifacts: [], failureCode: 'evidence_capture_incomplete', repairAvailable: true,
    failureReason: 'The preview agent could not reach the dialog.',
  }), { sessionId: 42 });
  assert.match(failed, /Couldn’t take the shots/);
  assert.match(failed, /The preview agent could not reach the dialog\./);
  assert.match(failed, /bg-red-500\/10/);
  assert.match(failed, />Take the shots again</);

  const conflict = AppView.visualEvidenceHtml(evidence({
    state: 'failed', artifacts: [], failureCode: 'visual_evidence_intent_conflict', repairAvailable: false,
    failureReason: 'The declaration says nothing visible changed.',
  }), { sessionId: 42 });
  assert.doesNotMatch(conflict, /Take the shots again/, 'a retry that would repeat the failure is not offered');
});

test('no state of the card says "Visual change preview"', () => {
  const states = ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'verified',
    'failed', 'stale', 'cancelled', 'not_required', 'overridden'];
  for (const state of states) {
    for (const extra of [{}, { failureCode: 'evidence_stopped' }, { notStartedReason: 'Switched off here.' }]) {
      const html = AppView.visualEvidenceHtml(evidence({ state, ...extra }), { sessionId: 42 });
      assert.doesNotMatch(html, /visual change preview/i, `${state} ${JSON.stringify(extra)}`);
    }
  }
});
