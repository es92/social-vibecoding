/**
 * `#gc-spec-side-panel` — the shared-spec reader's contents.
 *
 * It used to be group-chat.js's body: `_showSpecPanel` built the markup and
 * published a view model here, and the host's own class was the authoritative
 * open state. Since #6230 (3 Nov 2026) the open state and the document are
 * the detail store's (../ai/detail.ts), and this is one of the three things
 * that store's column draws — beside the thread it came from, in halves, or
 * whole-screen with a back arrow on a phone.
 *
 * ── Two body kinds, and the distinction is deliberate ─────────────────
 *
 * A spec renders as markdown; a 404 or a load failure renders as TEXT, because
 * formatting an error message turns it into something that looks like a
 * document. That was two branches of one HTML string and is two tags now, so
 * the error path cannot accidentally acquire markup.
 *
 * ── `Copy markdown` copies the RAW source ─────────────────────────────
 *
 * Not the rendered body: the store carries the markdown the server sent, and
 * clears it on close so a closed panel's document is not still copyable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useSpecFrames } from '../../lib/spec-html';
import { useDetailState, closeDetail, type SpecPanelBody } from '../ai/detail';
import { DetailActions, useDetailCard, useDetailLabel } from '../detail/detail-card';

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * Memoised on the STRING so the `{__html}` wrapper keeps its identity across
 * re-renders — React diffs host props by reference and re-assigns `innerHTML`
 * for a new object even when the string is identical. Same note as the
 * transcript's `Body`.
 */
function MarkdownBody({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className="gc-spec-panel-body" dangerouslySetInnerHTML={wrapper} />;
}

/** A piece of an HTML spec (#3699); its before/after screens are frames scaled to fit. */
function HtmlPart({ html, className, role }: { html: string; className?: string; role?: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  useSpecFrames(ref, html);
  return <div ref={ref} className={className} role={role} dangerouslySetInnerHTML={wrapper} />;
}

/**
 * An HTML spec with its two tabs, the plain-language half first. The tab is this panel's own and goes back to User-facing for each
 * new spec.
 */
export function SpecDocBody({ body }: { body: Extract<SpecPanelBody, { kind: 'spec' }> }) {
  const t = useMessages('chat');
  const [tab, setTab] = useState<'user' | 'tech'>('user');
  useEffect(() => { setTab('user'); }, [body.userHtml, body.html]);
  if (!body.split) return <HtmlPart className="gc-spec-panel-body" html={body.html} />;
  const half = tab === 'tech' ? body.techHtml : body.userHtml;
  const tabButton = (which: 'user' | 'tech', label: string) => (
    <button
      type="button"
      className={tab === which ? 'dc-spec-viewer-tab dc-spec-viewer-tab-active' : 'dc-spec-viewer-tab'}
      role="tab" aria-selected={tab === which} data-spec-tab={which}
      onClick={() => setTab(which)}
    >{label}</button>
  );
  return (
    <div className="gc-spec-panel-body">
      {body.preambleHtml ? <HtmlPart className="dc-spec-viewer-preamble" html={body.preambleHtml} /> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label={t('chat:group.spec.sections')}>
        {tabButton('user', t('chat:group.spec.tab.user'))}
        {tabButton('tech', t('chat:group.spec.tab.tech'))}
      </div>
      {half
        ? <HtmlPart role="tabpanel" html={half} />
        : <div role="tabpanel"><p className="dc-spec-tab-empty">{t('chat:group.spec.tabEmpty')}</p></div>}
    </div>
  );
}

function CopyButton({ raw }: { raw: string | null }) {
  const t = useMessages('chat');
  // What the button says is state, not text: read in the language on screen.
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const label = copied === 'copied' ? t('chat:group.spec.copy.copied')
    : copied === 'failed' ? t('chat:group.spec.copy.failed')
      : t('chat:group.spec.copy.label');
  return (
    <button
      className="gc-spec-panel-copy"
      aria-label={t('chat:group.spec.copy.title')}
      title={t('chat:group.spec.copy.title')}
      onClick={async () => {
        const ok = await ui()?.copyText?.(raw);
        setCopied(ok ? 'copied' : 'failed');
        if (!ok) ui()?.toast?.(t('chat:group.spec.copy.failedToast'));
        setTimeout(() => setCopied(null), 1500);
      }}
    >
      {label}
    </button>
  );
}

export interface SpecPanelViewProps {
  open: boolean;
  title: string;
  subtitle: string | null;
  canCopy: boolean;
  body: SpecPanelBody | null;
  /** The raw markdown Copy takes; never the rendered body. */
  raw?: string | null;
  /** `back` where the column is the whole screen (a phone): a ‹ instead of ×. */
  closeAs?: 'close' | 'back';
}

export function SpecPanelView({ open, title, subtitle, canCopy, body, raw = null, closeAs = 'close' }: SpecPanelViewProps) {
  const t = useMessages('chat');
  // Beside a thread on the bot tab (20 Nov 2026): the head card says the
  // plan's title and closes it, and Copy is drawn there (../detail/detail-card.tsx).
  const card = useDetailCard();
  useDetailLabel(open ? { title, line: subtitle } : null);
  if (!open) return null;
  return (
    <>
      {card ? (canCopy ? <DetailActions><CopyButton raw={raw} /></DetailActions> : null) : (
      <div className="gc-spec-panel-header">
        {closeAs === 'back' ? (
          <button
            className="gc-spec-panel-back dc-detail-back"
            aria-label={t('chat:group.spec.close')}
            onClick={closeDetail}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </button>
        ) : null}
        <div className="gc-spec-panel-titlewrap">
          <div className="gc-spec-panel-title">{title}</div>
          {subtitle ? <div className="gc-spec-panel-subtitle">{subtitle}</div> : null}
        </div>
        {canCopy ? <CopyButton raw={raw} /> : null}
        {closeAs === 'back' ? null : (
          <button
            className="gc-spec-panel-close"
            aria-label={t('chat:group.spec.close')}
            onClick={closeDetail}
          >
            ×
          </button>
        )}
      </div>
      )}
      {body && body.kind === 'spec' ? <SpecDocBody body={body} /> : null}
      {body && body.kind === 'markdown'
        ? <MarkdownBody html={body.html} />
        : body && body.kind === 'spec' ? null : (
          <div className="gc-spec-panel-body">
            <div className="gc-spec-panel-error">{body ? body.text : ''}</div>
          </div>
        )}
    </>
  );
}

/** The reader as the detail column draws it, for a host that only has the store. */
export function SpecPanel() {
  const state = useDetailState();
  return (
    <SpecPanelView
      open={!!state.entry}
      title={state.title}
      subtitle={state.subtitle}
      canCopy={state.canCopy}
      body={state.body}
      raw={state.raw}
    />
  );
}
