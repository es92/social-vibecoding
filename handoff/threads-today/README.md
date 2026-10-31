# Handoff: the Homeroom bot page and threads, 30–31 Oct 2026

Context for a new Claude Code session picking up from Evan's session of
30 Oct (on another account). This branch is a handoff, not a proposal: do
not submit it. Real changes start from a work order's base commit as
AGENTS.md says.

## Where things stand

- **Merged:** [#6041](https://github.com/Usernode-Labs/social-vibecoding/pull/6041)
  (the bot page and the bot's answer in Main tell one story) and
  [#6057](https://github.com/Usernode-Labs/social-vibecoding/pull/6057)
  (main `d5db478`). #6057 is the bot page as designed with Evan:
  - lists one line a row, grouped by project, three sheets, project chips;
  - "Up next" renamed **Waiting**;
  - Decide, Try again and claimed rows (`homeroom-bot-progress.js`
    `handedBack`, claims in `ai-work.js`);
  - a phone drawer with **Main Chat** (formerly "Main") peeking beside the
    list;
  - the bot's `my_work` answering status questions from the page's own
    lists (`ai-work.js` `pageLists`).

  AGENTS.md records the page's exception to "15 over 13".
- **Next piece of work: threads.** The spec is request #6019's plan,
  "Discussions become threads" (`get_spec` on usernode-2d5619 #6019). The
  five kinds Evan named were rendered from the live code. The review is the
  artifact in `artifact/`, published privately on the first account as
  https://claude.ai/artifact/WW6yQTFTh2PezcRsed1jZe.

## What the review found

1. **Bug (shipped in #6057):** on a desktop, a private thread opened from
   the bot page opens inside the 400px docked Main Chat beside the chat.
   That makes two panes of about 200px, so text wraps a word a line. The
   likely fix is to let the thread take the whole column with a back
   arrow, as the phone does. This was offered to Evan, not started.
2. A thread with a change has two pages, the request's and the change's,
   each with its own head, votes and Mute. From the bot page a vote row
   says the request's number but opens the change page.
3. A plan shows twice on a request page: a card under the request, and a
   "posted plan v1 · Read" line in the replies (not counted in "2 replies").
4. With two plans and two changes, nothing pairs a plan with the change
   built from it on the request page. Only the change page shows its plan.
5. The A/B vote reads 0·0·0 while A has one Yes and B two, none from
   approvers. Unlike the single change's card, it doesn't say why. Change
   A's own page shows two Votes cards (the A/B vote and its own, each with
   its own Vote button).
6. The Messages screen calls the same chat "Main Chat" in the header and
   "Homeroom bot · Builds what you ask for" over the conversation.
7. Once a change is up, the request page drops the
   Asked · Plan · Built · Voted in steps.

## Reproducing the screenshots

Needs a local Postgres 16, `npm ci` at the root and in `frontend/`, and
Playwright with Chromium (the cloud containers have both). From the
repository root:

```sh
npm run ensure:shell
createdb threads_demo   # or: psql -c 'CREATE DATABASE threads_demo'
handoff/threads-today/run-local.sh &   # wait for "Listening on :3999"
psql postgres://postgres:postgres@127.0.0.1:5432/threads_demo \
  -c "INSERT INTO app_numbers (app_id, next_number) VALUES (1, 6061) ON CONFLICT (app_id) DO UPDATE SET next_number = 6061"
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/threads_demo USERNODE_ENV=staging node handoff/threads-today/seed.js
node handoff/threads-today/shoot.cjs
node handoff/threads-today/shoot-from-bot-page.cjs
```

The seed writes into Homeroom (app 1) and prints the numbers:
- the private idea (Main Chat thread root 139);
- #6061, a request alone;
- #6062 with change #6063;
- #6064 with a plan and change #6065;
- #6066 with two plans and changes #6067 and #6068.

On a fresh database the ids can come out differently: `shoot.cjs` names
them in its `pages` list, so match them to what the seed printed. It signs
the screenshots in as `usernode-capture`, password
`capture-pass-123`, which it sets on this local database only. Shots land
in `shots/`. `artifact/img/` holds them as WebP, and `artifact/index.html`
is the page.

Things learned the hard way:

- A staging server reads real requests only when a git host is set, and
  serves mock ones otherwise. `run-local.sh` points `GIT_HOST_URL` nowhere.
- Staging fills a request with no comments with "[Mock]" ones. The shoot
  scripts answer that one call with production's empty list.
- A request filed in the product has an `issues` twin row (kind `general`)
  that names the asker. Without it the page says "someone".
- `chat_sessions.reviewed_head_sha` belongs to the proposal workflow. Write
  it with `set_config('app.wf_writer', 'transition', true)` in the same
  transaction. Without a head, a change's summary reads "Written for an
  earlier version of this change."
- Load each page fresh: after the bot page, a hash change opens the next
  route in the side panel beside it, not on its own page.

## Working with Homeroom from a session

- Submit through the Homeroom connector (`prepare_work`, then
  `submit_work`). #6057 went in as an uploaded patch (`patchUploadId`).
  The fork's branch for that session held merged history, and a force push
  to it was refused.
- `npm run test:changed -- --base <base sha>` against a local Postgres
  (`TEST_DATABASE_URL`). In a cloud container two `bench-capture-run` tests
  and one `spec-frame-styles` test fail the same way at the base commit:
  that is the container, not a change.
- The platform's dapp.json checks clip a selector at 256 characters
  (`tests/proposal-tests-manifest.test.js`). App CSS may not use a grab
  cursor (`tests/home-panels-render.test.js`).
