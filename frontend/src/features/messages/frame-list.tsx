/**
 * The Messages list in the one frame, version 2 (the tour's s15 and s20):
 * the first tour's layout holding the list the standard look draws.
 *
 * The page's head (Messages, one sentence, New message), People as the
 * page's tab, the product's search under it, then the conversations as the
 * kit's one row in one card. The standard list's People section is the
 * tab, and everything inside it is as it is there: a group's member count
 * after its name, and "N new" or the time. Agents was the second tab until
 * it left Messages (16 Nov 2026). What the list says when it is offline,
 * failed, loading, empty or searched to nothing is the product's sentence.
 *
 * Presentational. The list pane (./index.tsx ConversationList) builds each
 * row from the conversations and words it already has, and hands the result
 * here in place of its own rows while the device's look is one of the
 * frame's. Nothing is read, searched or opened in this file.
 */
import type { MouseEvent, ReactNode } from 'react';

import { Btn, Card, Frame, Head, Icon, Note, Pill, Row, Search, Sec, Tabs, k } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';

export interface FrameInboxRow {
  key: string;
  /** The picture: a person or a group (kit Av). */
  lead: ReactNode;
  title: string;
  /** One small word after the name: "AI" on a bot's direct message. */
  tag?: string | null;
  /** A group's size after its name: the figure, and the words a screen reader hears ("4 members"). */
  members?: { count: number; words: string } | null;
  line?: string | null;
  /** How long ago, in the list's own words, and the whole instant as its hover. */
  time?: string | null;
  timeTitle?: string | null;
  /** New since the viewer last looked, in words ("2 new"); the row then ends in the blue pill. */
  fresh?: string | null;
  active: boolean;
  href: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

export interface FrameInboxState {
  /** The first read is under way: nothing says "nothing here" yet. */
  loading: boolean;
  /** A read is under way with nothing to show yet, a retry after a failed one too: no tab says "Nothing here yet." meanwhile. */
  reading?: boolean;
  /** The read failed, in the store's words. */
  error: string | null;
  onRetry: () => void;
  offline: boolean;
  /** The inbox holds nothing at all (not: this search matched nothing). */
  empty: boolean;
  /** The empty inbox's one action: the product's create dialog. */
  onStart: () => void;
  /** What is being searched for, or null when nothing is. */
  searched: string | null;
}

function InboxRow({ row }: { row: FrameInboxRow }) {
  return (
    <Row
      // The list's own key, as the standard row carries it: what the pane finds a row by (index.tsx, #6508).
      data-inbox-row={row.key}
      href={row.href}
      onClick={row.onClick}
      lead={row.lead}
      title={(
        <>
          {/* The name is what is cut short: the badge and the member count after it are never pushed out of the row (app.css). */}
          <span className={k('cut')}>{row.title}</span>
          {row.tag ? <Pill mini>{row.tag}</Pill> : null}
          {row.members ? <span className={k('pill', 'mini')} role="img" aria-label={row.members.words} title={row.members.words}><Icon name="users" size={12} />{row.members.count}</span> : null}
        </>
      )}
      line={row.line || undefined}
      right={row.fresh
        ? <Pill kind="act">{row.fresh}</Pill>
        : row.time ? <span className={k('meta')} title={row.timeTitle || undefined}>{row.time}</span> : null}
      on={row.active}
    />
  );
}

export function MessagesFrameList({
  people, unread = 0, query, onQuery, onNew, state,
}: {
  people: FrameInboxRow[];
  /** Messages from people not read yet: the People tab's count. */
  unread?: number;
  query: string;
  onQuery: (next: string) => void;
  onNew: () => void;
  state: FrameInboxState;
}) {
  const t = useMessages('messages');
  const tc = useMessages('core');
  const has = people.length > 0;
  const placeholder = t('messages:inbox.searchPlaceholder');
  const label = t('messages:inbox.searchLabel');
  return (
    <Frame className="fr-pane" data-messages-frame-list="">
      <div className={k('scroll')}>
        <Head
          title={tc('core:tabs.messages')}
          purpose={t('messages:frame.inbox.purpose')}
          acts={<Btn icon="edit" onClick={onNew}>{t('messages:inbox.new.button')}</Btn>}
        />
        {/* The standard list's People heading, as the kit says one: the tab, with the unread count. */}
        <Tabs
          tabs={[{ key: 'people', label: t('messages:inbox.section.people'), count: unread }]}
          current="people"
        />
        {/* Under the tab at every width: the pane is 520px, too narrow for a field at the tabs' end. */}
        <Search value={query} onChange={onQuery} placeholder={placeholder} label={label} />
        <div className={k('stack')}>
          {state.offline ? <Note tone="wait">{t('messages:inbox.offline')}</Note> : null}
          {state.error ? (
            <Card pad>
              <div className={k('txt')} role="status" data-inbox-failed="">
                {`${state.error} `}
                <button type="button" className={k('link')} onClick={state.onRetry}>{tc('core:common.tryAgain')}</button>
              </div>
            </Card>
          ) : null}
          {state.loading ? <p className={k('txt')} role="status" data-inbox-loading="">{t('messages:inbox.loading')}</p> : null}
          {has ? (
            <Sec>
              <Card>
                {people.map((row) => <InboxRow key={row.key} row={row} />)}
              </Card>
            </Sec>
          ) : null}
          {state.empty ? (
            <Card pad text>
              <div className={k('sub15')}>{t('messages:inbox.empty.title')}</div>
              <p className={k('txt')}>{t('messages:inbox.empty.body')}</p>
              <div className={k('btnrow')}><Btn kind="quiet" small onClick={state.onStart}>{t('messages:inbox.empty.action')}</Btn></div>
            </Card>
          ) : has || state.loading || state.reading || state.error ? null : state.searched !== null ? (
            <Card pad><span data-inbox-search-empty="">{t('messages:inbox.searchEmpty', { query: state.searched })}</span></Card>
          ) : (
            <Card pad>{t('messages:frame.inbox.none')}</Card>
          )}
        </div>
      </div>
    </Frame>
  );
}
