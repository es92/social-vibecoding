# public/fonts/source-serif-4: the Source Serif 4 typeface, self-hosted

Source Serif 4 is the serif of the **signed-out hero**: the headline and the
two buttons on the landing's short story (`frontend/src/features/auth/story.tsx`)
and on the page about private communities
(`frontend/src/features/guest/guest-communities.tsx`). It is lighter and
tighter than Young Serif, which the section headings under those heroes keep.
The stylesheet names it as `--site-display` under `#auth-landing-screen`
(`public/css/app.css`, "THE WEBSITE'S LOOK ON THE SIGNED-OUT PAGES"), so only
a signed-out page asks for the file.

Served from our own origin, like `public/fonts/young-serif/`, so the shell
still makes no cross-origin asset requests. Only the Latin subset is
committed: a headline in another script falls back to Young Serif, then to
the system serif.

It is the variable file with the weight and optical-size axes. The hero sets
it at weight 400 (the buttons at 500) and optical size 28, which keeps the
hairlines sturdy at headline sizes.

## Provenance

Copied verbatim from the npm package, not from a CDN. The package is not a
dependency.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `source-serif-4-latin-opsz-normal.woff2` | `@fontsource-variable/source-serif-4` | 5.3.1 | `files/source-serif-4-latin-opsz-normal.woff2` | `evn7x+azr6PYq3DOgeObuTOkVKceROkR3IcrDIFMJS5hIy3mOsEj1SfRA80PvQ+7` | 119.5 KB |
| `LICENSE.txt` | `@fontsource-variable/source-serif-4` | 5.3.1 | `LICENSE` | | 4.3 KB |

Re-verify against npm with:

    npm pack @fontsource-variable/source-serif-4@5.3.1   # then sha384 the file

## Licence

SIL Open Font License 1.1 (`LICENSE.txt`, copied from the package). The OFL
asks that the licence travel with the font, so keep the two files together.
