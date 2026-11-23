# public/brand — the brand artwork the shell draws

HAND-EXPORTED and hand-committed. Nothing regenerates this directory: there is
no `npm run` that rewrites these files or this README, and the repository
carries no image tooling at all (no `sharp`, `imagemin`, `pngquant` or `svgo`
in either `package.json`, and the Docker build never touches an image). So the
only record of where a file came from and how it was made is the table below —
keep it true by hand, or the next person re-derives it from scratch.

Two of the three brand marks are files here. The in-app logotype ships as
SOURCE, inlined as eight `<path>` elements in
`frontend/@/components/ui/wordmark.tsx`, because `fill="currentColor"` lets
one drawing take the ink of wherever it sits — the landing header, the sign-in
card, the home header's app chip at 20px — with no dark variant, no second
file and no second request. Its own header explains the split. This note is
here so someone looking for the logo in the obvious place finds it.

`homeroom-mark.png` is the THIRD mark and the one this table's second
paragraph did not anticipate: the square brand tile — the cream figure on the
near-black squircle — as opposed to the logotype. #2718 put it in the header
as the button that opens the platform's menu, on every route. It is a file
rather than inlined source for the reason the logotype is the opposite: a
two-colour lockup does not re-colour per theme any more than an app's own icon
does, so there is nothing for `currentColor` to buy and a raster is the honest
shape for it. `public/sw.js` precaches it, because a missing header logo is a
hole at the top of every screen.

`homeroom-logotype-black.png` (below) is the one exception to "no image tooling
at all": email HTML has no `currentColor` and no inline SVG support worth
relying on across mail clients, so the mail frame (the standard email layout
first written by `src/db/email-template-seeds.js`, #2673) needs an actual raster file at a
fixed color, not the scalable source the app UI uses.

## Provenance

| File | Figma file key | Node id | Export | Dimensions | Size |
|---|---|---|---|---|---|
| `people.png` | `4kAYqXh9NhpoCU44QwWvYo` | `1246:166` | the node's raw image fill, downsampled and quantised (below) | 816 × 612, 8-bit palette PNG with `tRNS`, sRGB | 87.9 KB |
| `homeroom-mark.png` | n/a — no Figma export | n/a | supplied by the product owner as a finished raster during the navigation design study (#2718) and committed verbatim; no re-encoding, no quantisation, no tooling involved | 261 × 261, 8-bit RGBA PNG | 7.8 KB |
| `homeroom-logotype-black.png` | n/a — no Figma export | n/a | the eight `WORDMARK_PATHS` from `frontend/@/components/ui/wordmark.tsx` (viewBox `0 0 1236.9 319.2`) written into a plain SVG with `fill="#1c1c1e"` (`zinc-900`), then `rsvg-convert -w 280` (librsvg 2.63.2, a one-off local step whose output is committed) on a transparent background; drawn at 140 × 37 in the mail, so 2× (#2908) | 280 × 73, 8-bit RGBA PNG | 7.9 KB |
| `homeroom-logo-black.png` | n/a — no Figma export | n/a | hand-encoded: a 5×7 bitmap "HOMEROOM" wordmark rasterized to `zinc-900` (`#1c1c1e`) on a transparent RGBA background, then wrapped in a minimal PNG (`IHDR`/`IDAT`/`IEND`) using only Node's built-in `zlib.deflateSync` — see the one-off generator note in the git history for #2673, since the repo has no `sharp`/`canvas`/ImageMagick to export from | 294 × 54, 8-bit RGBA PNG | 451 B |
| `sky.webp` | n/a — no Figma export | n/a | the cloud image the Homeroom website (onhomeroom.com) draws behind its own hero, downloaded as the site serves it (PNG), resized to 1920 px wide, cropped to the middle 1080 rows and encoded with Pillow (`quality=74, method=6`), a one-off local step whose output is committed | 1920 × 1080, lossy WebP | 54.3 KB |
| `landing-communities.webp` | n/a — STAND-IN, cut from a mock-up | n/a | cropped from the hero mock-up Drea shared in the landing change's discussion (17 Nov 2026), its white ground flood-filled to transparent from the edges, encoded with Pillow (`quality=88, method=6`). Replace with an export of the drawing itself when there is one | 1060 × 656, lossy WebP with alpha | 82.7 KB |
| `landing-people.webp` | n/a — STAND-IN, cut from a mock-up | n/a | cropped from the same mock-up; the white window and the sky behind the figures removed by colour (flood fill from the edges, plus the sky enclosed between the figures), the window's edge line erased, the alpha edge softened by 0.7 px; Pillow (`quality=90, method=6`). Replace with an export of the drawing itself when there is one | 619 × 434, lossy WebP with alpha | 68.4 KB |

There is no `sha384` column, and the omission is deliberate rather than an
oversight. `public/vendor/README.md` records a digest per file because each of
those is a copy of a published npm artefact and the digest is re-verifiable
against upstream. A design export has no upstream to check against: a digest
here would prove only that nobody has changed the file since it was written
down, which the diff already proves. The file key plus the node id plus the
export recipe below IS the reproducibility claim.

**How `people.png` was made, and why not simply "export the node".** The
node's own PNG export bakes an opaque `#FFFEEA` frame background into the
image, which would draw as a cream rectangle on the dark ground — and the
illustration is specified to sit straight on the ground in both themes, with
no plate. So the export is the node's raw uploaded image fill instead, which
is transparent: 1448 × 1086 RGBA, Lanczos-downsampled to 816 px wide and
quantised with

    pngquant --quality=70-95 --speed 1 64

`pngquant` is on a developer machine (Homebrew), not in CI — this is a one-off
local step whose OUTPUT is committed. Measured at export against the
unquantised 3× render, the quantisation costs RMSE 4.1/255, which is invisible
on this artwork and takes the file from roughly 605 KB to 87.9 KB.

**Why 816 px.** The landing draws the illustration in a 272 pt box, so 816 is
3× — sharp on a 3× phone, which is the screen this redesign was drawn for and
the only one it is judged on. The weight is the reason to state that
explicitly: 87.9 KB is several times the largest artwork committed anywhere
else in the tree (the nine challenge illustrations run 5.5–21 KB, capped at
64 KB by `tests/challenge-illustrations.test.js`). Nothing in the suite
enforces a budget on this file. It is the logged-out screen's one image, it
carries the whole first impression, and 2× would save about 40 KB and lose the
reason it is there — but it was a choice, and this paragraph is where it is
recorded.

## What each one is for

- **people.png** — the illustration on the logged-out landing screen,
  `frontend/src/features/auth/landing.tsx`, drawn as a plain `<img>` above the
  activity chips. Decorative: the heading beside it carries the meaning, so it
  ships with an empty `alt`. The waitlist release email also draws it, as an
  absolute `${PRODUCTION_ORIGIN}/brand/people.png` URL in the
  `waitlist_released` template's first version (`src/db/email-template-seeds.js`, #4570), with the same
  empty `alt` — the headline under it carries the meaning there too.
- **sky.webp** — the clouds behind the two signed-out heroes (the landing's
  short story, `frontend/src/features/auth/story.tsx`, and the page about
  private communities, `frontend/src/features/guest/guest-communities.tsx`),
  drawn by `.site-clouds::before` in `public/css/app.css` in the light shell
  only, and the sky inside the window of the private page's walk-through
  (`.hx-main`, `.hx-banner`) in both. Under it is the flat `--site-sky`, which is what shows if the file
  does not load.
- **landing-communities.webp** — the picture of the communities page beside
  the landing hero's words, from 1024px. Decorative, empty `alt`.
- **landing-people.webp** — the people on the bottom edge of the landing
  hero's window, from 768px. Decorative, empty `alt`. It is drawn at up to 400px wide, so it is
  soft on a 2× screen: the mock-up it was cut from had no more pixels.
- **homeroom-logotype-black.png** — the logo at the top of every
  transactional email (#2908), referenced by the standard email layout's first
  version (`src/db/email-template-seeds.js`) as an absolute
  `${PRODUCTION_ORIGIN}/brand/homeroom-logotype-black.png` URL (a mail client
  has no page context to resolve a relative one against) with
  `alt="Homeroom"`. It is the app's own script logotype, rasterized.
- **homeroom-logo-black.png** — #2673's pixel-font "HOMEROOM", which the mail
  frame used before #2908. Nothing new references it; it stays so the logo in
  mail already sent keeps loading. The replacement took a new file name
  rather than new bytes under this one because mail clients and image proxies
  cache by URL. `/brand/` is on the public, unauthenticated path
  allowlist in `src/middleware/auth.js`, same as `/icons/` and
  `/illustrations/`, which is what lets a mail client fetch it with no
  session.

## Offline

The shell DOES precache images — `public/sw.js`'s `SHELL_ASSETS` lists the
three PWA icons, and `classifyRequest` has the matching `/icons/` rule that
makes them read back out of the cache. Precaching is those two halves
together; an entry with no rule fills the cache on install and is never read
from, because anything `classifyRequest` calls `'bypass'` is handled by the
browser and never consults the worker.

`people.png` is on the precached side, and both halves belong to whichever
proposal first draws it. The contrast worth knowing is challenge artwork,
which is deliberately left to the network and pinned that way in
`tests/pwa-sw-classify.test.js`: an offline challenge card whose picture fails
to load draws its kind icon instead, so caching nine SVGs would buy nothing a
reader can tell apart. The landing has no such fallback. `/index.html` is
precached, so a signed-out visitor CAN reach the new landing offline — and
without this entry they would reach it with a hole where the illustration is.

`sky.webp`, `landing-communities.webp` and `landing-people.webp` are not in
`SHELL_ASSETS` either. They are decoration with an empty `alt` or a flat
colour under them, so an offline visitor loses the pictures and nothing
else; `classifyRequest`'s `/brand/` rule still reads them from the cache once
they have been fetched.

`homeroom-logotype-black.png` (and the retired `homeroom-logo-black.png`) is
deliberately NOT added to `SHELL_ASSETS`. The service worker only ever
precaches assets the app SHELL itself draws — this one is drawn exclusively by outside mail clients rendering `HTML_SHELL`
output, which the app's own worker never fetches or serves, so a precache
entry for it would fill the cache on install and never be read back out.

## Replacing an asset

1. Re-export from the node id in the table above — the raw image fill, not the
   node's PNG export, for the transparency reason recorded above.
2. Re-run the downsample and `pngquant` line above, and measure the result
   with `ls -l` rather than predicting it.
3. Commit the new bytes and update this table's Dimensions and Size in the
   same commit.
4. Keep the file's `SHELL_ASSETS` entry and its `classifyRequest` rule in
   `public/sw.js`, and bump `SW_VERSION` there: an installed client holds the
   precached copy until the worker version changes, so replacing the bytes
   under the same URL otherwise reaches new visitors only.

There is no step here about editing `public/index.html`. That file is
generated from `frontend/` and gitignored — the vendor README's equivalent
step predates the React shell and must not be copied across.

## `bg/` — the brand kit's six backgrounds

`bg/sky.webp`, `bg/halftone.webp`, `bg/dream.webp`, `bg/stars.webp`,
`bg/stripes.webp` and `bg/collage.webp` are the six backgrounds of Baked
Design Studio's Homeroom brand guidelines (`baked.design/brand/homeroom/`,
which needs a sign-in; its files are under `/brand/homeroom/bg/`), saved on
19 Nov 2026 and committed verbatim: each 1076 × 600 WebP, 5 to 26 KB, no
re-encoding. Standard (WIP) draws one across the top of each pinned
community's card on the Communities page (app.css, `--wip-scene-1` to `-6`).
They are decoration loaded by the stylesheet when that page is drawn, so
they are not in `public/sw.js`'s precache list. `bg/sky.webp` is also the
soft sky behind the closing band of the page about private communities
(`.site-sky-soft`).

## `groups/` — the pictures on the page about private communities

Fifteen WebP files drawn by the signed-out page at `/communities`
(`frontend/src/features/guest/guest-communities.tsx`, the B3 design), all
named in `public/css/app.css` ("THE PAGE ABOUT PRIVATE COMMUNITIES") except
the six `benefit-*` drawings, which the component names by its card's key.

**Where they came from.** Every one was taken out of the B3 design file the
product owner supplied on 23 Nov 2026 (`private-communities-B3.html`, a
single page with its pictures embedded) and committed as embedded: the same
bytes, no resize and no re-encoding. The design file does not say where its
pictures came from, so neither can this table. **The three photographs
(`friends.webp`, `avatar-kai.webp`, `avatar-zoe.webp`) show real people:
their source and the right to use them were not recorded with the design and
should be confirmed by whoever supplied it.** Replace a file here with one of
the same name and the page follows.

| File | What it is | Dimensions | Size |
|---|---|---|---|
| `groups/stars.webp` | the brand green with pale stars, behind "What your group gets" and "Your group, your rules" | 1200 × 675 | 71.6 KB |
| `groups/friends.webp` | a photograph of three friends, on the "Friend groups" card | 1100 × 580 | 36.0 KB |
| `groups/benefit-private.webp` | brand drawing: two people | 96 × 96 | 4.5 KB |
| `groups/benefit-around.webp` | brand drawing: an eye | 96 × 96 | 3.4 KB |
| `groups/benefit-vote.webp` | brand drawing: a party popper | 96 × 96 | 7.5 KB |
| `groups/benefit-comment.webp` | brand drawing: a pencil | 96 × 96 | 4.2 KB |
| `groups/benefit-talk.webp` | brand drawing: a speech bubble | 96 × 96 | 4.7 KB |
| `groups/benefit-credit.webp` | brand drawing: a trophy | 96 × 96 | 4.9 KB |
| `groups/avatar-f1.webp`, `groups/avatar-f3.webp`, `groups/avatar-f4.webp`, `groups/avatar-m3.webp`, `groups/avatar-m4.webp` | brand characters, as the faces of made-up members in the hero's walk-through | 96 × 96 | 1.6 to 2.3 KB each |
| `groups/avatar-kai.webp`, `groups/avatar-zoe.webp` | photographs of two faces, for two more made-up members | 96 × 96 | 1.8 and 2.0 KB |

They are decoration (empty `alt`, or a background behind words that read
without it) and are not in `SHELL_ASSETS`: an offline visitor loses the
pictures and nothing else. The design file also carried three more brand
characters and a second picture for the "Friend groups" card that the page
does not draw; they were not committed. Its soft sky behind the closing band
was the brand kit's sky at another size, so the page draws `bg/sky.webp`
(above) instead of a second copy.
