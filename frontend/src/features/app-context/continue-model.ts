// The rows under "Agent chats" in the Homeroom menu (#2779 follow-up; it was
// "Continue" until the UI overhaul, then "Agent sessions", then "More"): your
// agent sessions, so going back to one is a tap from anywhere. Pure, so tests
// can read the rules without a browser. The section itself shows only once
// the viewer has had an agent session (../agent-session/store.ts
// agentChatsShown, first-session run-through, 5 Oct 2026).
//
// The rules:
//   - every app's, not only the one the menu is open on, and on Home too: a
//     session is yours to continue wherever you are, and the old per-app
//     filter hid a change you had just started whenever the app it named was
//     not the one on screen (or it named none);
//   - the five most recent, and `more` when there are others, which the menu
//     answers with "Show more" (Messages' Agents list);
//   - agent sessions only: a conversation stands for the changes it started,
//     and the Workshop is one row above for everything else;
//   - "paused" is not a state of the work (the platform pauses an idle
//     session and resumes it when it is used), so it is listed like any other;
//   - a conversation nothing was said in yet (no title, since the first
//     message titles it, and no change) is not work in progress;
//   - newest first, each with the mark the other lists draw (./activity):
//     a spinner while it works, a green dot once it finished unseen;
//   - A SESSION THAT IS WORKING IS ALWAYS LISTED (#3073), however many newer
//     ones there are. Recents keeps thirty rows on the same clock, so a
//     session could spin there while five newer ones pushed it out of these
//     rows: the two lists disagreed about the very thing the spinner is for.
//     The working ones take their places first and the newest others fill
//     what is left of the five; the rows stay newest first. More than five
//     working at once are all listed, since each is something in progress.

import { agentActivity, type AgentActivity } from '../agent-session/activity';
import { changeRowWords } from '../agent-session/transcript';

export interface ContinueAgentSession {
  id: number;
  title: string | null;
  status: string;
  lastActivityAt: string | null;
  createdAt?: string | null;
  focusApp: { slug: string | null; name?: string | null } | null;
  activeChange: {
    appSlug: string | null;
    appName?: string | null;
    status: string | null;
    title: string | null;
    /** A merge of Homeroom itself not live yet: when its release comes (../../lib/release-eta.ts). */
    release?: unknown;
  } | null;
  busy?: boolean;
  doneUnseen?: boolean;
}

export interface ContinueRow {
  key: string;
  /** The session itself, for what a row can do to it: a swipe archives it (#3515). */
  sessionId: number;
  href: string;
  title: string;
  detail: string;
  /**
   * "Run Club · in progress": the app the work is on, then where it stands,
   * the line under the title (UI overhaul). Where it stands alone when the
   * session names no app yet.
   */
  sub: string;
  activity: AgentActivity;
}

export interface ContinueList {
  rows: ContinueRow[];
  /** More sessions qualify than the rows show. */
  more: boolean;
}

export const CONTINUE_MAX = 5;

function time(value: string | null | undefined): number {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

/** The app a session's work is on: its change's, else the one it started from. */
function agentApp(session: ContinueAgentSession): string | null {
  return (session.activeChange && session.activeChange.appName)
    || (session.focusApp && session.focusApp.name)
    || null;
}

/** "Run Club · in progress", or "In progress" with no app to name. */
export function agentSub(app: string | null, detail: string): string {
  return app ? `${app} · ${detail.charAt(0).toLowerCase()}${detail.slice(1)}` : detail;
}

function agentDetail(session: ContinueAgentSession, now: number): string {
  const change = session.activeChange;
  if (!change) return 'Agent session';
  // A merge of Homeroom itself says when the platform's next release
  // carries it: "Homeroom · goes live in about 8 minutes".
  return changeRowWords(change, now);
}

export function continueRows(
  agentSessions: ContinueAgentSession[],
  max = CONTINUE_MAX,
  now: number = Date.now(),
): ContinueList {
  const current = agentSessions
    .filter((session) => session.status === 'open' && (session.title || session.activeChange))
    .sort((a, b) => (time(b.lastActivityAt) || time(b.createdAt)) - (time(a.lastActivityAt) || time(a.createdAt)));
  const working = current.filter((session) => agentActivity(session) === 'working');
  const room = Math.max(0, max - working.length);
  const others = new Set(current.filter((session) => agentActivity(session) !== 'working').slice(0, room));
  const shown = current.filter((session) => others.has(session) || agentActivity(session) === 'working');
  const rows = shown
    .map((session): ContinueRow => ({
      key: `agent:${session.id}`,
      sessionId: session.id,
      href: `#messages/agent/${session.id}`,
      title: session.title || (session.activeChange && session.activeChange.title) || 'Agent session',
      detail: agentDetail(session, now),
      sub: agentSub(agentApp(session), agentDetail(session, now)),
      activity: agentActivity(session),
    }));
  return { rows, more: current.length > shown.length };
}
