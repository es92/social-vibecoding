/**
 * The Mermaid kind (#4490): the author's text, drawn by Homeroom.
 *
 * The library is vendored (public/vendor/mermaid-<version>.min.js, provenance
 * in public/vendor/README.md), so the shell still loads nothing cross-origin.
 * It is large, so it is loaded HERE, on demand, the first time a card or a
 * change's page holds a Mermaid diagram, and never on any other screen. It is
 * not a script tag and not in the service worker's precache list.
 *
 * The rules a diagram is drawn under, all of them load-bearing:
 *   - `securityLevel: 'strict'`: labels are text, no click handlers.
 *   - `htmlLabels: false` (flowcharts too): no <foreignObject> HTML.
 *   - `logLevel` fatal and `suppressErrorRendering`: a bad source throws to
 *     us and nothing reaches the console as an error (a console error fails
 *     proposal checks).
 *   - The SVG it returns goes through the vendored DOMPurify (SVG profile)
 *     before anyone inserts it, and a picture of more than MAX_PARTS nodes or
 *     edges is treated as a failure, as a source that does not parse is.
 * The server has already refused directives, click, href, callback and tags
 * (src/services/diagram.js); this is the second fence, not the first.
 */

export const MERMAID_SRC = '/vendor/mermaid-11.17.2.min.js';
export const MAX_PARTS = 30;

type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

let library: Promise<MermaidApi> | null = null;

/**
 * The library, loaded once. Its bundle sets `window.mermaid`; that global is
 * put back as it was, so nothing else on the page sees it appear.
 */
export function loadMermaid(): Promise<MermaidApi> {
  if (library) return library;
  const p = new Promise<MermaidApi>((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no document')); return; }
    const w = window as unknown as Record<string, unknown>;
    const had = Object.prototype.hasOwnProperty.call(w, 'mermaid');
    const before = w.mermaid;
    const s = document.createElement('script');
    s.src = MERMAID_SRC;
    s.async = true;
    s.onload = () => {
      const lib = w.mermaid as MermaidApi | undefined;
      if (had) w.mermaid = before;
      else delete w.mermaid;
      s.remove();
      if (lib && typeof lib.render === 'function') resolve(lib);
      else reject(new Error('the diagram library did not load'));
    };
    s.onerror = () => { s.remove(); reject(new Error('the diagram library did not load')); };
    document.head.appendChild(s);
  });
  library = p;
  p.catch(() => { if (library === p) library = null; });
  return p;
}

let seq = 0;

/** The settings every diagram is drawn with. Exported for the test. */
export function mermaidConfig(dark: boolean): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    theme: dark ? 'dark' : 'neutral',
    logLevel: 5,
    suppressErrorRendering: true,
    maxTextSize: 2000,
    maxEdges: 100,
    fontFamily: 'inherit',
  };
}

/** How many nodes and edges a drawn picture has, from its markup. */
export function countParts(svg: Element): { nodes: number; edges: number } {
  const nodes = svg.querySelectorAll('.node, .actor-top, .stateGroup, .er.entityBox, g[id^="entity-"]').length;
  const edges = svg.querySelectorAll('.flowchart-link, .edgePath, .messageLine0, .messageLine1, .transition, .relation, .relationshipLine').length;
  return { nodes, edges };
}

type Purify = { sanitize(html: string, config: Record<string, unknown>): string };

/**
 * Draw one source. Resolves the cleaned SVG markup; rejects when the library
 * cannot load, the source does not parse, or the picture is too big. The
 * caller falls back to "What it touches" on a rejection.
 */
export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const purify = (window as unknown as { DOMPurify?: Purify }).DOMPurify;
  if (!purify || typeof purify.sanitize !== 'function') throw new Error('no sanitiser');
  const mermaid = await loadMermaid();
  mermaid.initialize(mermaidConfig(dark));
  seq += 1;
  const id = `hr-diagram-${seq}`;
  let svg = '';
  try {
    ({ svg } = await mermaid.render(id, source));
  } finally {
    // Mermaid measures in a scratch node it may leave behind on a failure.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
  const clean = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
  // Mermaid's own arrowheads are url(#marker) references inside the
  // picture; anything else would load from elsewhere.
  if (/url\(\s*['"]?(?!#)/i.test(clean) || /@import/i.test(clean)) throw new Error('loads from elsewhere');
  const holder = document.createElement('div');
  holder.innerHTML = clean;
  const root = holder.querySelector('svg');
  if (!root) throw new Error('no picture');
  const { nodes, edges } = countParts(root);
  if (nodes > MAX_PARTS || edges > MAX_PARTS) throw new Error('too big');
  return clean;
}
