/**
 * #chromeless-pill — the floating "Open in Homeroom" affordance shown while the
 * platform header is hidden (`/app/<slug>/full`). App._mountChromelessPill /
 * _unmountChromelessPill in app.js, as a component (#1079 chunk B).
 *
 * Visually matching the bridge's share-view pill (public/usernode-bridge.js
 * __USERNODE_PLATFORM_LINK__) so users see one consistent affordance. Unlike
 * the bridge pill it is NOT dismissible — in chromeless mode it's the only way
 * into the full platform view. The slug is read at CLICK time, not at render,
 * so the pill survives app-to-app navigation without a remount — the same
 * reason the imperative version read App.currentApp inside its handler.
 *
 * The inline styles came across as-is rather than becoming utilities: they use
 * env(safe-area-inset-*) in calc(), which Tailwind has no class for, and the
 * pill has to keep matching the bridge's hard-coded pill exactly.
 */

import { useState, type CSSProperties } from 'react';

import { useVisibility } from '../../lib/visibility-store';

const PILL_STYLE: CSSProperties = {
  position: 'fixed',
  right: 'calc(12px + env(safe-area-inset-right,0px))',
  bottom: 'calc(12px + env(safe-area-inset-bottom,0px))',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  background: 'rgba(15,20,32,0.82)',
  color: '#e7edf7',
  borderRadius: '999px',
  padding: '6px 12px',
  font: '12px/1.2 -apple-system,system-ui,sans-serif',
  textDecoration: 'none',
  boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
};

const GLYPH_STYLE: CSSProperties = { fontSize: '11px', opacity: 0.75 };

export function ChromelessPill() {
  // Published by App.setChromeless. Unpublished reads as undefined, which
  // useVisibility resolves to this `false` — i.e. the shipped markup, which
  // had no pill in it at all.
  const chromeless = useVisibility('chromeless-pill', false);
  const [hover, setHover] = useState(false);

  if (!chromeless) return null;

  return (
    <a
      id="chromeless-pill"
      href="#"
      aria-label="Open this app on Homeroom"
      style={{ ...PILL_STYLE, opacity: hover ? 1 : 0.85 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(ev) => {
        ev.preventDefault();
        const slug = window.App?.currentApp;
        if (slug) {
          // The explicit route entry point clears the mode while keeping the
          // already-loaded iframe mounted (same app, same tab).
          window.App?.openAppTab?.(slug, 'app');
        }
      }}
    >
      <span>Open in Homeroom</span>
      <span style={GLYPH_STYLE} aria-hidden="true">
        {'↗'}
      </span>
    </a>
  );
}
