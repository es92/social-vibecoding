/**
 * The connector walkthrough, inline on the dev session page (#2706).
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * The hand-off launchpad's third step asks for the Homeroom connector,
 * because without it the agent cannot call prepare_work and there is
 * nothing useful to hand it. Until now "Connect Homeroom" was a button
 * that assigned `#settings/connectors` — a whole screen away, in a pane
 * the reader has to scroll and a route they then have to find their way
 * back from, to satisfy one step of a walkthrough that is otherwise
 * self-contained. The request is to teach it HERE.
 *
 * So the steps come to the launchpad. The facts do not get retyped:
 * ../settings/connector-setup-steps holds the one copy of the Claude.ai
 * and ChatGPT walkthroughs and BOTH screens render it. Settings keeps its
 * route, untouched, and keeps everything this card deliberately does not
 * carry — the Claude Code permission rules, the Codex and generic-client
 * routes, the connector list itself. A launchpad step is not the place to
 * reproduce a settings pane; it is the place to answer the one question
 * the step just asked.
 *
 * ── A stateful island, and why that is allowed here ──────────────────
 *
 * Per AGENTS.md a region may hold state only when its whole subtree is
 * React-owned. This one is: it is rendered by view.tsx as an ordinary
 * child of the launchpad slot, beside (never inside) the innerHTML the
 * walkthrough card still comes from, and no public/js/** module looks any
 * node in here up. dev-chat.js owns whether it is on screen and reaches
 * back the same way OwnToolsGuide does — by name on `window.DevChat` —
 * because that module cannot import (see features/dev-chat/mount.ts).
 *
 * The URL is the live `${origin}/mcp`, passed in rather than written into
 * the prose, for the reason sections/connectors.tsx gives: a host spelled
 * out in copy goes stale on a fork or a config change. The ChatGPT steps
 * take it as a prop too, so the step that asks for the paste shows the
 * same value the field above it does.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';

import {
  ChatgptSetupSteps,
  ClaudeSetupSteps,
} from '../settings/connector-setup-steps';

export type ConnectorProduct = 'Claude' | 'ChatGPT';

export interface ConnectorSetupInlineView {
  /** Which chat product this hand-off's agent signs in as. */
  product: ConnectorProduct;
  /** The live connector endpoint, `${origin}/mcp`. */
  url: string;
  /** Does the account already have a connector somewhere? Changes the lead. */
  connected: boolean;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * The server URL with its own Copy, above the steps that say to paste it.
 * Same control as Settings' #connector-url row and the own-tools guide's
 * code blocks — a read-only field rather than a <pre>, because on a phone
 * this is the one value somebody may need to select by hand. A new thread's
 * setup steps draw the same field (../messages/thread-builder.tsx).
 */
export function ConnectorUrl({ url }: { url: string }) {
  const t = useMessages('devchat');
  // What the last press came to; the label is read from it when it renders.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
      <input
        readOnly
        data-connector-setup-url="1"
        value={url}
        aria-label={t('devchat:connector.urlLabel')}
        className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs font-mono text-zinc-700 dark:text-zinc-300 outline-none"
      />
      <Button
        type="button"
        layout="shrink"
        variant="unstyled"
        size="none"
        ink="none"
        className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center border-s border-zinc-200 dark:border-zinc-800 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label={t('devchat:connector.copyUrl')}
        onClick={async () => {
          const ok = await ui()?.copyText?.(url);
          setCopyState(ok ? 'copied' : 'failed');
          if (!ok) ui()?.toast?.(t('devchat:connector.copyFailedToast'), { error: true });
          setTimeout(() => setCopyState('idle'), 1500);
        }}
      >
        {copyState === 'copied'
          ? t('core:common.copied')
          : copyState === 'failed' ? t('devchat:connector.copyFailed') : t('core:common.copy')}
      </Button>
    </div>
  );
}

export function ConnectorSetupInline({ view }: { view: ConnectorSetupInlineView }) {
  const { product, url, connected } = view;
  const t = useMessages('devchat');
  return (
    <div className="dc-launchpad" data-connector-setup={product}>
      <div className="dc-launchpad-lead">{t('devchat:connector.lead', { product })}</div>
      <p className="dc-launchpad-sub">
        {connected
          // The status count spans every Claude and ChatGPT account the
          // person has connected, so it can be non-zero while the account
          // they are about to paste into has nothing. Same caveat the
          // walkthrough card carries, said where it can be acted on.
          ? t('devchat:connector.otherAccount', { product })
          : t('devchat:connector.intro', { product })}
      </p>

      <div className="mt-3">
        <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('devchat:connector.urlLabel')}</div>
        <ConnectorUrl url={url} />
      </div>

      <div className="mt-4">
        {product === 'ChatGPT' ? <ChatgptSetupSteps url={url} /> : <ClaudeSetupSteps />}
      </div>

      {/* The one fact neither product's own walkthrough states, and the one
          that sends people back here thinking it failed: a connector added
          mid-conversation is not in the conversation they added it from. */}
      <p className="mt-3 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
        {product === 'ChatGPT' ? t('devchat:connector.startNewChatgpt') : t('devchat:connector.startNewClaude')}
      </p>

      <div className="dc-flow-actions">
        <Button
          type="button"
          layout="shrink"
          variant="unstyled"
          size="none"
          ink="none"
          className="dc-pr-btn dc-flow-action dc-flow-action-primary"
          data-connector-setup-action="done"
          onClick={() => (window as any).DevChat?._devFlowConnectorDone()}
        >
          {t('devchat:connector.done')}
        </Button>
        {/* Settings keeps the rest of the reference — the Claude Code
            permission rules, Codex, other MCP clients, and the list of what
            is already connected — so the route stays, as a way on rather
            than as the only place the steps exist. */}
        <a className="dc-pr-btn dc-flow-action" href="#settings/connectors">{t('devchat:connector.moreSettings')}</a>
      </div>
    </div>
  );
}
