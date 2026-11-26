/**
 * The project page's Discussion tab: the community's channel, whole, in
 * place.
 *
 * The hub shows the discussion's last line and a way in (./hub-cards.tsx
 * ForYouCard, its Discussion row). The way in used to leave the page
 * for `#messages/app/<slug>`; it is a tab of the page now, so a person
 * reading the hub and a person talking in the room are on the same page with
 * the same coloured header, and Back is the tab strip rather than a screen
 * swap.
 *
 * ── The same room, mounted the way Messages mounts it ─────────────────
 *
 * The pane is group-chat's (AppView.renderGroupChatTab: the stream, the
 * composer, drafts, the @ and # menus), mounted into a host this component
 * renders empty and never writes into again: the one-owner rule satisfied at
 * the host's boundary, as in features/messages/index.tsx AppDiscussionThread,
 * whose effect this copies, timer and teardown order included (#2783: the
 * composer is wired on the line after the portal is published, which cannot
 * happen inside React's commit).
 *
 * ── Homeroom's own room is #general, in place too (#3494) ─────────────
 *
 * Its channel is #general, a conversation of the Messages store rather than
 * an app chat. It used to be a door: the tab opened #general on the Messages
 * screen, which swapped the page's header, its tabs and its colour for
 * Messages' own (#3491). Now the tab turns like every other project's and
 * the room is drawn here, under the same header — Messages' own thread,
 * composer and reply threads (features/messages/index.tsx
 * EmbeddedConversation), holding the store's one route while this page is
 * the screen on show. `generalRoom` reads which conversation it is.
 *
 * ── Every way into the room ends here, at its place (#3653) ───────────
 *
 * A notification, a message link, a `#name` reference or an old address of
 * the room used to open it on a page of its own, with its own back button.
 * They come to this tab now (app.js App.openDiscussionInHub and the
 * router's redirects), carrying what they named in the room as a TARGET
 * (AppView._stashDiscussionTarget): a reply thread, opened beside the room
 * here as it opens beside it in Messages, or a message, brought into view
 * and flashed. The tab takes it when it shows the room, and again when a
 * door is followed while the room is already up. A reply thread opened from
 * the room itself comes the same way (public/js/group-chat.js
 * openReplyThread), with no address of its own: the page's address is the
 * page's, as it is for #general's threads.
 *
 * ── A topic's channel, too (#4417) ───────────────────────────────────
 *
 * A project's channels are #general and its TOPICS: lasting conversations
 * about one part of it, each a channel and a category at once (a category
 * row with origin 'topic'; ./places.ts). The place names which (`channel`,
 * a handle; null or `general` is #general), and a topic's channel is its
 * 'category' thread on the app's own chat, under the topic's line
 * (./topic-head.tsx). On Homeroom's own project too, where #general is a
 * Messages conversation and the topics are threads of the app's chat: the
 * list hides the difference.
 *
 * #4417 follow-up: THE TOPIC'S ROOM IS #general's PANE. A topic's channel
 * is the general stream one level down (src/routes/chat.js selectStream:
 * its own messages, and the replies of the reply threads that start in it),
 * so it is mounted the way a project's own #general is
 * (AppView.renderGroupChatTab, in a host this component renders empty),
 * scoped to the topic (`channel`, GroupChat._channel). It was a thread
 * mount, and the group chat holds one thread at a time, so its messages
 * could not open reply threads of their own. Now they do, beside it, in
 * the same pane #general's open in (AppReplyThreadPane), and a door that
 * names a place in it (a notification's `m/<id>` or `thread/<root>`) is
 * taken here as #general's door is there, by its topic (`topicRef`).
 *
 * A retired topic (archived, or merged into another) is read-only, with its
 * whole history. A topic that others were merged into draws one card in its
 * history for each, where the merge happened (./merged-topic-card.tsx),
 * handed to the history as markers: nothing was posted for them.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { XIcon } from '@/components/ui/icons';
import { type CommunityPayload, type PlaceChannel } from './community-card';
import { AppReplyThreadPane, ChannelLoading, EmbeddedConversation } from '../../messages';
import { CardHomeContext } from '../../messages/format';
import { closeThread, embeddedThreadOpen } from '../../messages/store';
import { navStore } from '../../nav/nav-store.js';
import { registerLevel } from '../../workshop/tab-ladder';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import type { TranscriptMarker } from '../../group-chat/transcript-store';
import { ChannelHead } from './channel-head';
import { channelPlace, channelsOf, findChannel, mergedInto, type PlaceKey } from './places';
import { TopicHead } from './topic-head';
import { TopicFigures } from './topic-figures';
import { TopicSignals } from './topic-signals';

type Channel = NonNullable<CommunityPayload['channel']>;

/** What a door asked for in the room (AppView._stashDiscussionTarget). */
export interface DiscussionTarget {
  threadRootId: number | null;
  focusMessageId: number | null;
  conversationId: number | null;
}

/** A channel this page can mount: an app's own, addressed in Messages' app threads. */
function embeddable(channel: Channel | null): boolean {
  return !!channel && channel.handle !== 'general'
    && (!channel.href || channel.href.startsWith('#messages/app/'));
}

/**
 * The conversation a channel is when it is one of Messages' own rooms —
 * #general, on Homeroom's page (`#messages/<id>`) — or null for an app's own
 * channel, and for none.
 */
export function generalRoom(data: CommunityPayload | null | undefined): number | null {
  const channel = data?.channel || null;
  if (!channel || embeddable(channel)) return null;
  const m = /^#messages\/([1-9]\d{0,9})$/.exec(channel.href || '');
  const id = m ? Number(m[1]) : null;
  return id && id <= 2147483647 ? id : null;
}

/**
 * The target waiting for `slug`'s room, taken, or null. `place` is the one
 * asking: #general's chat or the Discussion's posts. #4417 follow-up: a
 * target names the topic whose channel it is in (`topicRef`, a registry
 * row), and only that channel's place takes it; #general's takes one that
 * names none. Another channel's target is left where it is, for its place.
 */
export function takeDiscussionTarget(slug: string, topicRef: number | null = null, place: 'discussion' | 'posts' = 'discussion'): DiscussionTarget | null {
  const view = (window as unknown as {
    AppView?: {
      _peekDiscussionTarget?: (slug: string) => { topicRef?: number | null } | null;
      _takeDiscussionTarget?: (slug: string) => Partial<DiscussionTarget> | null;
      _discussionPlaceFor?: (target: object | null) => string;
    };
  }).AppView;
  const waiting = view?._peekDiscussionTarget?.(slug) || null;
  if (waiting && (Number(waiting.topicRef) || null) !== (topicRef || null)) return null;
  // #general IS THE DISCUSSION (26 Nov 2026): a message or a thread in
  // #general is the Discussion's posts' to take (./hub-discussion.tsx), the
  // room itself and what the posts hand on are the chat's. The door tells
  // the page it is waiting a moment before it turns the page, so the place
  // being left must not take what is for the other.
  if (waiting && !topicRef && (view?._discussionPlaceFor?.(waiting) || 'discussion') !== place) return null;
  const t = view?._takeDiscussionTarget?.(slug) || null;
  if (!t) return null;
  return {
    threadRootId: t.threadRootId || null,
    focusMessageId: t.focusMessageId || null,
    conversationId: t.conversationId || null,
  };
}

export function ProjectDiscussion({ slug, name, data, channel = null, onPlace }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
  /** #4417: the channel the place names: a topic's handle, or null for #general. */
  channel?: string | null;
  /** #4417: go to another of the page's places. */
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  const handle = channel && channel !== 'general' ? channel : null;
  if (handle) return <TopicChannelPlace slug={slug} name={name} data={data} handle={handle} onPlace={onPlace} />;
  return <GeneralChannel slug={slug} name={name} data={data} />;
}

/**
 * #general: the project's own channel, under its line (#5303,
 * ./channel-head.tsx: what it is for, its members, and Mute).
 */
function GeneralChannel({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const t = useMessages('project');
  const host = useRef<HTMLDivElement | null>(null);
  const channel = data?.channel || null;
  const mountable = embeddable(channel);
  const room = generalRoom(data);
  const readOnly = !channel?.post_url;
  // The room holds Messages' one route only while this page is the screen
  // on show: #app-view stays mounted, hidden, behind every other screen, and
  // behind the running app on its App tab (the one #app-view route that
  // lights no tab).
  const { screen, tab } = useStoreState(navStore) as { screen: string | null; tab: string | null };
  const onShow = screen === 'app-view' && !!tab;
  // #3653: the reply thread open beside a project's own channel, and the
  // place a door named in #general. `key` makes the same thread asked for
  // again (a second notification for it) a fresh mount: the router's pass
  // on the way here lets go of whatever thread the group chat had.
  const [thread, setThread] = useState<{ rootId: number; key: number } | null>(null);
  const [roomAt, setRoomAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !mountable) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) view?.renderGroupChatTab?.({ host: el, slug, name, readOnly, archived: false });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      // The transcript's portal first: it points INTO #gc-messages inside
      // the pane (rule 1 in lib/legacy-portals.tsx).
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
      (window as any).GroupChat?.releaseUnreadHold?.(slug);
    };
  }, [slug, name, readOnly, mountable]);

  // A thread belongs to the room it was opened in.
  useEffect(() => { setThread(null); setRoomAt(null); }, [slug]);

  // #3701: A REPLY THREAD IS A LEVEL BELOW THE TAB. The Communities tab,
  // pressed while it is lit, closes it before it goes any higher
  // (../../workshop/tab-ladder.ts): the room is the tab, and the thread
  // beside it is the page below. No address changes, as none did when it
  // opened. #general's thread is the Messages store's; an app's is ours.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  useEffect(() => registerLevel({
    slug,
    below: () => (room ? embeddedThreadOpen(room) : !!threadRef.current),
    up: () => { if (room) closeThread(); else setThread(null); },
    // #4417: a thread is below the channel, which is below the Hub.
    depth: 2,
  }), [slug, room]);

  // THE DOOR'S TARGET, taken once the page knows which room this is (the
  // community record has landed): now, and whenever a door is followed
  // while the tab is up. Declared after the mount above and run in the same
  // commit, so a message to bring into view is asked for before the group
  // chat's first history load (a macrotask later) can answer it.
  const known = !!data;
  useEffect(() => {
    if (!known) return undefined;
    const apply = () => {
      const target = takeDiscussionTarget(slug);
      if (!target) return;
      if (room) {
        // #general's place is the store's to find: its thread opens beside
        // it, its message is read around and flashed (EmbeddedConversation).
        if (target.threadRootId || target.focusMessageId) {
          setRoomAt({ threadRootId: target.threadRootId, focusMessageId: target.focusMessageId });
        }
        return;
      }
      if (!mountable) return;
      if (target.focusMessageId) {
        // The group chat scrolls to it and flashes it once its stream has
        // it, and opens the reply thread it lives in when it is a reply.
        (window as any).GroupChat?.revealMessage?.(slug, target.focusMessageId);
      }
      if (target.threadRootId) {
        const rootId = target.threadRootId;
        setThread((cur) => ({ rootId, key: (cur?.key || 0) + 1 }));
      }
    };
    apply();
    // A door followed while the tab is up: taken a turn later, once the
    // router's own pass (which may render this page afresh) is over — a
    // fresh copy takes it as it mounts instead, and this one lets it be.
    let live = true;
    let timer = 0;
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string } | null>).detail;
      if (!detail || detail.slug !== slug) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (live) apply(); }, 0);
    };
    window.addEventListener('usernode:workshop-discussion', onTarget);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener('usernode:workshop-discussion', onTarget);
    };
  }, [slug, known, room, mountable]);

  // Until the record says which room it is, the room's own loading row: the
  // channel opens in the one state it then keeps until its messages are in.
  if (!data) return <ChannelLoading />;
  if (room) {
    return (
      <section
        className="dev-ws-discussion dev-ws-general-channel"
        data-ws-discussion=""
        data-ws-discussion-room={channel?.handle || ''}
        aria-label={t('project:discussion.label', { project: name })}
      >
        <ChannelHead slug={slug} name={name} data={data} />
        {/* #5303: a card from another project says which one it is from. */}
        <CardHomeContext.Provider value={slug}>
          <EmbeddedConversation conversationId={room} active={onShow} at={roomAt} />
        </CardHomeContext.Provider>
      </section>
    );
  }
  if (!mountable) {
    return <p className="dev-ws-week-note" data-ws-discussion-none="">{t('project:discussion.none')}</p>;
  }
  // The section's class says whether a thread is beside the room; the
  // host's own never changes, and its subtree stays the group chat's.
  // `data-discussion-app` names the room as Messages' pane does, so the
  // group chat brings a message into view here at once when it is already
  // up (GroupChat.revealMessage).
  return (
    <section
      className={`dev-ws-discussion dev-ws-general-channel${thread ? ' dev-ws-discussion-threaded' : ''}`}
      data-ws-discussion=""
      data-discussion-app={slug}
      aria-label={t('project:discussion.label', { project: name })}
    >
      <ChannelHead slug={slug} name={name} data={data} />
      <div ref={host} className="dev-ws-discussion-host" />
      {thread ? (
        <AppReplyThreadPane
          key={`${thread.rootId}:${thread.key}`}
          slug={slug}
          rootId={thread.rootId}
          ready
          readOnly={readOnly}
          where={name}
          close={(
            <button
              type="button"
              className="messages-thread-action"
              aria-label={t('project:discussion.closeThread')}
              title={t('project:discussion.closeThread')}
              onClick={() => setThread(null)}
            >
              <XIcon aria-hidden="true" />
            </button>
          )}
        />
      ) : null}
    </section>
  );
}

/**
 * #4417: the place of a topic's channel. Waits for the community record
 * (which says what the handle is), then mounts the channel; a handle the
 * project has no topic for says so, with the way back to the hub.
 */
function TopicChannelPlace({ slug, name, data, handle, onPlace }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
  handle: string;
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  const t = useMessages('project');
  if (!data) return <ChannelLoading />;
  const topic = findChannel(data.places, handle);
  if (!topic || topic.kind !== 'topic' || topic.id == null) {
    return (
      <p className="dev-ws-week-note" data-ws-discussion-none="">
        {t('project:discussion.topic.none', { handle })}
      </p>
    );
  }
  // Posting takes collab access (the channel row is only there with it) and
  // membership, which the composer asks for on its first send (join_required).
  const readOnly = !data.channel;
  return <TopicChannel key={topic.id} slug={slug} name={name} data={data} topic={topic} readOnly={readOnly} onPlace={onPlace} />;
}

function TopicChannel({ slug, name, data, topic, readOnly, onPlace }: {
  slug: string;
  name: string;
  data: CommunityPayload;
  topic: PlaceChannel;
  readOnly: boolean;
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  const t = useMessages('project');
  const host = useRef<HTMLDivElement | null>(null);
  const ref = Number(topic.id);
  const closed = topic.state !== 'live';
  // The topic a merged one joined, by its key, for its line and its link.
  const survivor = topic.state === 'merged' && topic.merged_into
    ? channelsOf(data.places).find((c) => c.kind === 'topic' && c.key === topic.merged_into) || null
    : null;
  // The merges into this topic, as cards the history draws at their time.
  const markers = useMemo<TranscriptMarker[]>(() => mergedInto(data.places, topic).map((m) => ({
    key: `merged-${m.key}`,
    at: String(m.merged_at),
    kind: 'merged-topic',
    from: { handle: m.handle, name: m.name, icon: m.icon },
  })), [data.places, topic]);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const notice = closed
    ? (topic.state === 'merged'
      ? (survivor
        ? t('project:discussion.topic.mergedInto', { handle: topic.handle, into: survivor.handle })
        : t('project:discussion.topic.mergedIntoAnother', { handle: topic.handle }))
      : t('project:discussion.topic.archived', { handle: topic.handle }))
    : t('project:discussion.topic.joinToPost');
  // The reply thread open beside the channel, as beside #general: `key`
  // makes the same thread asked for again (a second notification) a fresh
  // mount.
  const [thread, setThread] = useState<{ rootId: number; key: number } | null>(null);

  // THE ROOM: #general's pane, scoped to the topic's stream. Mounted out of
  // React's commit, as #general's is (#2783), into a host whose subtree is
  // the group chat's; the transcript's portal is dropped first (rule 1 in
  // lib/legacy-portals.tsx). Reading it is the pane's too (GroupChat.markRead,
  // with the topic's own cursor, app_category_chat_reads).
  //
  // Only while this page is the screen on show, as Homeroom's #general holds
  // Messages' route (GeneralChannel): #app-view stays mounted, hidden, behind
  // every other screen, and the group chat has one general pane. Homeroom's
  // archived app chat opens in Messages (AppDiscussionThread) and takes it
  // there; a channel read off screen would be read without being seen.
  const { screen, tab } = useStoreState(navStore) as { screen: string | null; tab: string | null };
  const onShow = screen === 'app-view' && !!tab;
  useEffect(() => {
    const el = host.current;
    if (!el || !onShow) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    let live = true;
    const timer = window.setTimeout(() => {
      if (!live) return;
      view?.renderGroupChatTab?.({
        host: el,
        slug,
        name,
        readOnly: readOnly || closed,
        archived: false,
        channel: { type: 'category', ref, markers: markersRef.current, handle: topic.handle, about: String(topic.about || '').trim() },
        placeholder: t('project:discussion.topic.placeholder', { handle: topic.handle }),
        notice,
      });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
      (window as any).GroupChat?.releaseUnreadHold?.(slug);
    };
  }, [slug, name, ref, readOnly, closed, topic.handle, notice, onShow]);

  // A merge that lands while the channel is open draws its card at once.
  useEffect(() => {
    (window as any).GroupChat?.setThreadMarkers?.('category', ref, markers);
  }, [ref, markers]);

  // A REPLY THREAD IS A LEVEL BELOW THE CHANNEL (#3701, #4417): the
  // Communities tab, pressed while it is lit, closes it before it goes up.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  useEffect(() => registerLevel({
    slug,
    below: () => !!threadRef.current,
    up: () => setThread(null),
    depth: 2,
  }), [slug]);

  // THE DOOR'S TARGET, named for this topic (place-store.ts openTopicRef,
  // GroupChat._openThreadInPage): now, and whenever a door is followed while
  // the channel is up. A message is brought into view and marked, a reply
  // thread opened beside the channel, as #general's are (GeneralChannel).
  useEffect(() => {
    const apply = () => {
      const target = takeDiscussionTarget(slug, ref);
      if (!target) return;
      if (target.focusMessageId) {
        (window as any).GroupChat?.revealMessage?.(slug, target.focusMessageId, ref);
      }
      if (target.threadRootId) {
        const rootId = target.threadRootId;
        setThread((cur) => ({ rootId, key: (cur?.key || 0) + 1 }));
      }
    };
    apply();
    let live = true;
    let timer = 0;
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string } | null>).detail;
      if (!detail || detail.slug !== slug) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (live) apply(); }, 0);
    };
    window.addEventListener('usernode:workshop-discussion', onTarget);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener('usernode:workshop-discussion', onTarget);
    };
  }, [slug, ref]);

  const openRequests = () => {
    // All items, narrowed to the topic: the Workshop's own filter by
    // category (AppView.openBoardForTheme), under the theme the grouping
    // drew the topic as.
    const themes = devWorkshopStore.get().themes || [];
    const theme = themes.find((t) => t.topic && t.topic.key === topic.key);
    (window as any).AppView?.openBoardForTheme?.(theme ? theme.id : topic.key);
  };

  // `data-discussion-app` names the room as #general's place does, so the
  // group chat opens a reply thread here (GroupChat._openThreadInPage) and
  // brings a message into view at once when the channel is already up
  // (GroupChat.revealMessage).
  return (
    <section
      className={`dev-ws-discussion dev-ws-topic-channel${thread ? ' dev-ws-discussion-threaded' : ''}`}
      data-ws-discussion=""
      data-ws-topic={topic.handle}
      data-ws-topic-state={topic.state}
      data-discussion-app={slug}
      aria-label={`#${topic.handle}`}
    >
      <TopicHead
        slug={slug}
        topic={topic}
        survivor={survivor ? survivor.handle : null}
        onRequests={openRequests}
        onSurvivor={survivor && onPlace ? () => onPlace(channelPlace(survivor.handle)) : undefined}
      />
      {/* The numbers this topic names in dapp.json, between its line and
          its room (topic-figures.tsx); nothing for a topic with none. */}
      <TopicFigures slug={slug} topic={topic} />
      {/* What the platform found wrong in this topic and filed as requests,
          under its figures (topic-signals.tsx); nothing when there is none. */}
      <TopicSignals slug={slug} topic={topic} />
      {/* The host's class string is constant and its subtree is the group
          chat's: the one-owner rule, satisfied at this boundary. */}
      <div ref={host} className="dev-ws-discussion-host dev-ws-topic-host" data-topic-channel={topic.id} />
      {thread ? (
        <AppReplyThreadPane
          key={`${thread.rootId}:${thread.key}`}
          slug={slug}
          rootId={thread.rootId}
          ready
          readOnly={readOnly || closed}
          where={`#${topic.handle}`}
          close={(
            <button
              type="button"
              className="messages-thread-action"
              aria-label={t('project:discussion.closeThread')}
              title={t('project:discussion.closeThread')}
              onClick={() => setThread(null)}
            >
              <XIcon aria-hidden="true" />
            </button>
          )}
        />
      ) : null}
    </section>
  );
}
