/**
 * 10 Nov 2026: who works on a new thread (./new-thread.tsx). Homeroom bot,
 * as it always was, or the person's own Claude Code or ChatGPT, on the plan
 * they already pay for.
 *
 *   [▦ Any project ⌄] [H Homeroom bot ⌄]   ← BuilderChip, beside the project's
 *   ┌───────────────────────────┐
 *   │ Who works on it?          │ ← BuilderPicker: a sheet from the floor on
 *   │ H  Homeroom bot         ✓ │   a phone, a menu above the chip from 768px,
 *   │ >_ Claude Code    Set up  │   in the project picker's own rows
 *   │ ◯  ChatGPT        Set up  │
 *   └───────────────────────────┘
 *
 * Claude Code and ChatGPT reach Homeroom through its connector, which lives
 * in the person's Claude or ChatGPT account. So a pick whose product has no
 * live connection opens the steps to add one in the thread's place
 * (BuilderSetup: the MCP server URL, the walkthrough Settings › Connectors
 * and the hand-off both draw, Check again, and a way back to Homeroom bot).
 * With one, the thread keeps its starts and its box, and sending opens the
 * product in a new tab with the person's own words already in it and a line
 * telling it to use the connector: nothing is sent to Homeroom bot and no
 * thread is made here. What it builds comes back as a change for the group
 * to vote on, as any agent's submitted work does.
 *
 * Only the person's OWN words go into the link (builderPrompt). They typed
 * them into this box to be sent, so there they are their instructions. A
 * request's title or body never is: that is somebody else's writing, and
 * ../../lib/claude-code-link.ts says why it stays out of a link.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The chip's first render is the default's, Homeroom bot. Which products are
 * connected is read only when the picker opens (useBuilderConnections), never
 * in a first render, and the picker and the steps are drawn only after a
 * press.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/grouped-list';
import { ChatIcon, ChevronDownIcon, TerminalIcon } from '@/components/ui/icons';
import { CLAUDE_CODE_WEB_URL } from '../../lib/claude-code-link';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useMenu } from '../../lib/menu';
import { useSheet } from '../../lib/sheet';
import { ChatgptSetupSteps, ClaudeSetupSteps } from '../settings/connector-setup-steps';
import { ConnectorUrl } from '../settings/connector-url';
import * as api from './api';
import { BOT_AVATAR } from './format';
import { useWide } from './project-picker';
import { SWITCHER_ROW, SwitcherTick } from '../workshop/community-switcher';

export type Builder = 'homeroom' | 'claude-code' | 'chatgpt';
export type OwnBuilder = Exclude<Builder, 'homeroom'>;
export const BUILDERS: readonly Builder[] = ['homeroom', 'claude-code', 'chatgpt'];

/** What each is called. Product names, the same in every language. */
export const BUILDER_NAME: Record<OwnBuilder, string> = { 'claude-code': 'Claude Code', chatgpt: 'ChatGPT' };
/** The chat product whose account holds the connector. */
export const BUILDER_PRODUCT: Record<OwnBuilder, 'Claude' | 'ChatGPT'> = { 'claude-code': 'Claude', chatgpt: 'ChatGPT' };

/** Where ChatGPT opens a new chat with words already in it (Settings' own "Ask ChatGPT to guide you"). */
export const CHATGPT_WEB_URL = 'https://chatgpt.com/';

/** The most of the person's words a link carries: an address has a length. */
export const HANDOFF_MAX = 3000;

/** An app slug as the platform mints them (../../lib/claude-code-link.ts). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Pure: which products have a live connection. Read off the name each
 * client chose, the way Settings sorts its cards (settings.js
 * _connectorTool): Codex is its own client, not the ChatGPT chat.
 */
export function connectedBuilders(rows: ReadonlyArray<{ clientName: string; live: boolean }>): Record<OwnBuilder, boolean> {
  const out: Record<OwnBuilder, boolean> = { 'claude-code': false, chatgpt: false };
  for (const row of rows || []) {
    if (!row || !row.live) continue;
    const name = String(row.clientName || '').toLowerCase();
    if (/claude|anthropic/.test(name)) out['claude-code'] = true;
    else if (/codex/.test(name)) continue;
    else if (/chatgpt|openai/.test(name)) out.chatgpt = true;
  }
  return out;
}

/**
 * Pure: what the product opens with. The person's words, then a line for
 * the agent, in English whatever the interface's language, as the work
 * orders are. It names the project when one was picked.
 */
export function builderPrompt(words: string, slug: string | null): string {
  const said = String(words || '').trim();
  const where = slug && SLUG.test(slug)
    ? `Use the Homeroom connector for this, on the Homeroom app \`${slug}\`. Call get_connector_guidance first,`
    : 'Use the Homeroom connector for this. Call get_connector_guidance first, find the project with list_apps,';
  return `${said}\n\n${where} and check list_requests for a duplicate before filing anything. `
    + 'If something gets built, submit it with submit_work so it goes to the group for a vote.';
}

/** Pure: the address that opens the product with the prompt in it, or null for no words or too many. */
export function builderLink(builder: OwnBuilder, words: string, slug: string | null): string | null {
  const said = String(words || '').trim();
  if (!said || said.length > HANDOFF_MAX) return null;
  const prompt = encodeURIComponent(builderPrompt(said, slug));
  return builder === 'claude-code' ? `${CLAUDE_CODE_WEB_URL}?prompt=${prompt}` : `${CHATGPT_WEB_URL}?q=${prompt}`;
}

export interface BuilderConnections {
  /** `idle` until the picker first opens; `failed` when the list could not be read. */
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  connected: Record<OwnBuilder, boolean>;
  /** Read the list again; what it found, or null when it could not be read. */
  load: () => Promise<Record<OwnBuilder, boolean> | null>;
}

/** Which products are connected, read when asked and never before. */
export function useBuilderConnections(): BuilderConnections {
  const [state, setState] = useState<Pick<BuilderConnections, 'phase' | 'connected'>>({
    phase: 'idle', connected: { 'claude-code': false, chatgpt: false },
  });
  const turn = useRef(0);
  const load = useCallback(async () => {
    turn.current += 1;
    const mine = turn.current;
    setState((now) => ({ ...now, phase: 'loading' }));
    try {
      const connected = connectedBuilders(await api.listConnectors());
      if (mine === turn.current) setState({ phase: 'ready', connected });
      return connected;
    } catch {
      if (mine === turn.current) setState((now) => ({ ...now, phase: 'failed' }));
      return null;
    }
  }, []);
  return { ...state, load };
}

function BuilderGlyph({ builder }: { builder: OwnBuilder }): ReactNode {
  return builder === 'claude-code' ? <TerminalIcon /> : <ChatIcon />;
}

/** The chip over the message box, beside the project's: who works on the thread. */
export function BuilderChip({ builder, open, onOpen }: {
  builder: Builder;
  open: boolean;
  onOpen: (el: HTMLButtonElement) => void;
}): ReactNode {
  const t = useMessages('messages');
  const own = builder === 'homeroom' ? null : builder;
  const name = own ? BUILDER_NAME[own] : t('messages:newThread.builder.homeroom.name');
  return (
    <button
      type="button"
      // One look (25 Nov 2026): a menu chip, the shared part, its lead word quiet.
      className="messages-project-chip one-chip"
      data-bot-new-thread-builder={builder}
      data-picked={own ? '' : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {/* Phone review S13: Homeroom bot's mark is the Homeroom project's too,
          so beside "About: Homeroom" it made two pills look alike; "With:"
          says who it is. Claude Code's and ChatGPT's glyphs still show. */}
      {own ? (
        <span className="messages-project-chip-tile messages-project-chip-any" aria-hidden="true"><BuilderGlyph builder={own} /></span>
      ) : null}
      {/* Phone review S13: it says what it picks ("About: Homeroom", "With:
          Homeroom bot"), and those words are its name for a screen reader. */}
      <span className="messages-project-chip-name"><RichMessage id="messages:newThread.builder.chip" values={{ builder: name }} components={[<span className="messages-project-chip-label one-chip-lead" />]} /></span>
      <ChevronDownIcon className="messages-project-chip-chev" aria-hidden="true" />
    </button>
  );
}

function PickerBody({ builder, links, menu, onPick }: {
  builder: Builder;
  links: BuilderConnections;
  menu: boolean;
  onPick: (builder: Builder) => void;
}): ReactNode {
  const t = useMessages('messages');
  const known = links.phase === 'ready';
  return (
    <>
      <div className="community-switcher-head">
        <h2 className="community-switcher-title" id="bot-builder-picker-title">
          {menu ? t('messages:newThread.builder.label') : t('messages:newThread.builder.title')}
        </h2>
      </div>
      <div className="community-switcher-list">
        {BUILDERS.map((key) => {
          const own = key === 'homeroom' ? null : key;
          const current = builder === key;
          const connected = !!own && known && links.connected[own];
          const sub = !own
            ? t('messages:newThread.builder.homeroom.sub')
            : connected
              ? t('messages:newThread.builder.ownConnected', { product: BUILDER_PRODUCT[own] })
              : t('messages:newThread.builder.own', { product: BUILDER_PRODUCT[own] });
          return (
            <ListRow
              key={key}
              as="button"
              inset="none"
              className={SWITCHER_ROW}
              data-bot-builder-option={key}
              aria-current={current ? 'true' : undefined}
              style={current ? { background: 'var(--bg-secondary)' } : undefined}
              onClick={() => onPick(key)}
              leading={own ? (
                <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true"><BuilderGlyph builder={own} /></span>
              ) : (
                <span className="community-switcher-tile" aria-hidden="true"><img src={BOT_AVATAR} alt="" /></span>
              )}
              title={own ? BUILDER_NAME[own] : t('messages:newThread.builder.homeroom.name')}
              subtitle={sub}
              trailing={(
                <>
                  {/* The switcher's own accent pill ("3 to vote"): the one thing on the row that asks for something. */}
                  {own && known && !connected ? (
                    <span className="community-switcher-waiting" data-bot-builder-needs-setup="">{t('messages:newThread.builder.setUp')}</span>
                  ) : null}
                  <SwitcherTick on={current} />
                </>
              )}
              chevron={false}
            />
          );
        })}
      </div>
      <p className="community-switcher-note" data-bot-builder-note="">{t('messages:newThread.builder.note')}</p>
    </>
  );
}


type PickerProps = { builder: Builder; links: BuilderConnections; onPick: (builder: Builder) => void; onClose: () => void };

function PickerSheet({ builder, links, onPick, onClose }: PickerProps): ReactNode {
  // The kit's own sheet when it is there (lib/sheet.ts), focus on the row
  // picked now.
  const { panelRef: panel, adopted, scrimProps } = useSheet({
    kind: 'sheet',
    onClose,
    initialFocus: (el) => el.querySelector<HTMLButtonElement>('[aria-current="true"]'),
  });
  return (
    <div
      className={adopted ? 'contents' : 'community-switcher-scrim'}
      {...scrimProps}
    >
      <div
        ref={panel}
        id="bot-builder-picker"
        className="community-switcher community-switcher-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-builder-picker-title"
      >
        {adopted ? null : <span className="community-switcher-grab" aria-hidden="true" />}
        <PickerBody builder={builder} links={links} menu={false} onPick={onPick} />
      </div>
    </div>
  );
}

function PickerMenu({ builder, links, anchor, onPick, onClose }: PickerProps & { anchor: HTMLElement | null }): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null);
  // A press outside it or on the chip, Escape, Back, and focus: on the row
  // picked now, and back to the chip (lib/menu.ts).
  const { panelProps } = useMenu(true, {
    trigger: { current: anchor },
    panel,
    onClose,
    keys: 'panel',
    initialFocus: (el) => el.querySelector<HTMLButtonElement>('[aria-current="true"]'),
  });
  // Hung above the chip, as the project picker's menu is above its own.
  const box = anchor?.getBoundingClientRect();
  const width = 364;
  const style: CSSProperties = box
    ? {
      left: `${Math.max(8, Math.min(Math.round(box.left), window.innerWidth - width - 8))}px`,
      bottom: `${Math.round(window.innerHeight - box.top + 8)}px`,
      maxHeight: `${Math.max(240, Math.min(560, Math.round(box.top - 16)))}px`,
    }
    : { left: '50%', top: '12vh', transform: 'translateX(-50%)' };
  return (
    <div
      ref={panel}
      id="bot-builder-picker"
      className="community-switcher community-switcher-menu"
      role="dialog"
      aria-labelledby="bot-builder-picker-title"
      style={style}
      {...panelProps}
    >
      <PickerBody builder={builder} links={links} menu onPick={onPick} />
    </div>
  );
}

/** The picker itself, while `open`: a sheet on a phone, a menu above the chip from 768px. */
export function BuilderPicker({ open, builder, links, anchor, onPick, onClose }: PickerProps & {
  open: boolean;
  anchor: HTMLElement | null;
}): ReactNode {
  const wide = useWide();
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('hashchange', onClose);
    window.addEventListener('popstate', onClose);
    return () => {
      window.removeEventListener('hashchange', onClose);
      window.removeEventListener('popstate', onClose);
    };
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    wide
      ? <PickerMenu builder={builder} links={links} anchor={anchor} onPick={onPick} onClose={onClose} />
      : <PickerSheet builder={builder} links={links} onPick={onPick} onClose={onClose} />,
    document.body,
  );
}

/**
 * The steps to connect a product, where the thread's messages and box go
 * until it is connected. The walkthrough is Settings › Connectors' own
 * (../settings/connector-setup-steps.tsx), so the two cannot drift.
 */
export function BuilderSetup({ builder, checking, missed, onCheck, onUseBot }: {
  builder: OwnBuilder;
  /** A read of the connections is under way. */
  checking: boolean;
  /** Check again found no connection for this product. */
  missed: boolean;
  onCheck: () => void;
  onUseBot: () => void;
}): ReactNode {
  const t = useMessages('messages');
  const name = BUILDER_NAME[builder];
  const product = BUILDER_PRODUCT[builder];
  // The live endpoint, never a host written into the copy (sections/connectors.tsx says why).
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}/mcp`;
  return (
    <div className="messages-builder-setup" data-bot-builder-setup={builder}>
      <p className="m-0 text-[0.9375rem] leading-snug text-zinc-700 dark:text-zinc-300">
        {t('messages:newThread.builder.setup.lead', { builder: name, product })}
      </p>
      <div>
        <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('messages:newThread.builder.setup.url')}</div>
        <ConnectorUrl url={url} />
      </div>
      {product === 'ChatGPT' ? <ChatgptSetupSteps url={url} /> : <ClaudeSetupSteps />}
      <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
        {t('messages:newThread.builder.setup.startNew', { product })}
      </p>
      {missed ? (
        <p role="status" className="m-0 text-[0.8125rem] leading-[1.125rem] text-amber-800 dark:text-amber-300" data-bot-builder-missed="">
          {t('messages:newThread.builder.setup.missed', { product })}
        </p>
      ) : null}
      <div className="flex flex-col gap-1 pt-1">
        <Button type="button" disabled={checking} onClick={onCheck} data-bot-builder-check="">
          {t('messages:newThread.builder.setup.check')}
        </Button>
        <button
          type="button"
          className="min-h-[44px] rounded-lg text-[0.9375rem] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
          onClick={onUseBot}
          data-bot-builder-use-bot=""
        >
          {t('messages:newThread.builder.setup.useBot')}
        </button>
      </div>
    </div>
  );
}
