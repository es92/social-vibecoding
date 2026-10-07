/**
 * "Import a GitHub repo": the make screen's second form (./make.tsx), what
 * its small "Import from a GitHub repo" opens from the Create button, and
 * what #create/import opens directly. It took over from the New project
 * dialog's import step when that dialog was retired: the same check, the
 * same POST /api/apps, in the make screen's own fields.
 *
 *   repo     The GitHub repo's URL and Check. The check is GET
 *            /api/github/verify-access: usernode-bot must have Write access
 *            (accepting a pending invitation is part of it, which is why it
 *            is a press and not a check on every keystroke), and it reads the
 *            repo's dapp.json. Any edit to the URL puts the check back to
 *            idle, so a verified repo A can never be imported as repo B.
 *   name     What to call it, opened on the repo's own name when its
 *            dapp.json has one and nothing was typed yet.
 *
 * It is a private community, like everything Make it makes (audience
 * 'invited', nobody invited yet: Share invite comes next, on the made
 * screen), unless the repo's dapp.json says otherwise, which it does once it
 * is deployed (services/app-manifest.js); the note under the check says so
 * before the press. Nothing is built from a description: the repo already
 * says what it is, so nothing is sketched and Homeroom bot builds nothing.
 *
 * "Import it" is never pale for a missing answer, as Make it is not: a press
 * without a checked repo, or without a name, says what it needs under that
 * field and puts the caret there.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SpinnerArcIcon } from '@/components/ui/icons';

import { normalizeRepositoryUrl } from '../dialogs/repository-url';

/** What a repo's dapp.json already says, as the check reads it. */
export interface RepoManifest {
  name?: string | null;
  description?: string | null;
  visibility?: { build: 'public' | 'private' | null; view: 'public' | 'private' | null } | null;
  governance?: { approvers: 'anyone' | 'invited'; approvals: number | null } | null;
}

export type CheckResult =
  | { ok: true; fullName: string; manifest: RepoManifest; unread: boolean }
  | { ok: false; error: string };

/**
 * GET /api/github/verify-access for a URL, read into what the form shows.
 * `manifest` is {} when the repo has no dapp.json; `unread` when the server
 * could not read it. Never throws.
 */
export async function checkRepo(url: string, fetcher: typeof fetch = fetch): Promise<CheckResult> {
  if (!url) return { ok: false, error: 'Paste a GitHub repo URL first.' };
  let res: Response;
  try {
    res = await fetcher(`/api/github/verify-access?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
  } catch {
    return { ok: false, error: 'Network error. Try again.' };
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* a non-JSON body is reported through the HTTP status below */
  }
  if (!res.ok) return { ok: false, error: (typeof data.error === 'string' && data.error) || `Check failed (HTTP ${res.status}).` };
  const manifest = data.manifest as RepoManifest | null | undefined;
  return {
    ok: true,
    fullName: (data.fullName as string) || `${data.owner}/${data.repo}`,
    manifest: manifest && typeof manifest === 'object' ? manifest : {},
    unread: manifest === null,
  };
}

/** Every repository is public on GitHub, whoever may open the project. */
const CODE_PUBLIC = 'Its code stays public on GitHub.';

/** Who a repo's dapp.json lets in, in the words the old dialog's notice used. */
export function visibilityWords(v: NonNullable<RepoManifest['visibility']>): string {
  if (v.build === 'public' && v.view === 'public') return 'anyone can find it, join and build';
  if (v.build === 'private' && v.view === 'public') return 'anyone can see it, and only people invited can build';
  if (v.build === 'public') return 'anyone can build it';
  return `it is private to the people invited. ${CODE_PUBLIC}`;
}

/**
 * The line under a checked repo: what its dapp.json decides that this screen
 * would otherwise decide (who it is for), or that it could not be read. Null
 * when it changes nothing. Pure, for tests/create-front-door.test.js.
 */
export function repoNote(manifest: RepoManifest | null, unread: boolean): string | null {
  if (unread) return 'Couldn’t read this repo’s dapp.json. Anything it sets still applies once it’s imported.';
  const v = manifest?.visibility;
  if (v && (v.build === 'public' || v.view === 'public')) {
    return `Its dapp.json says ${visibilityWords(v)}, so it starts that way rather than as a private community.`;
  }
  return null;
}

export type ImportMissing = 'repo' | 'name' | null;

/** The first answer "Import it" still needs; null when the repo is checked and named. */
export function importMissing(checked: boolean, name: string): ImportMissing {
  if (!checked) return 'repo';
  if (!name.trim()) return 'name';
  return null;
}

export type Imported = { slug: string; name: string; description: string | null };

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
const HINT = 'pb-1 text-xs text-zinc-500 dark:text-zinc-400';
const NEEDED = 'pb-1 text-xs text-red-700 dark:text-red-400';

type CheckState = 'idle' | 'checking' | 'ok' | 'error';

/**
 * The form, inside the make screen's frame: its `className` is the make
 * form's own and `header` its heading, so the two forms stand in the same
 * place. `submit` posts the import (the make screen's own request) and
 * answers an error to show, or null once it has handed the project on.
 */
export function ImportForm({ className, header, submit, onDescribe, allowance, blocked = false }: {
  className: string;
  header: ReactNode;
  /** At the allowance's limit: Import it is pale (the make screen's rule). */
  blocked?: boolean;
  submit: (answers: { repoUrl: string; name: string; manifest: RepoManifest }) => Promise<string | null>;
  /** "Describe a new project instead": back to Make it. */
  onDescribe: () => void;
  /** The make screen's allowance row, when it bears on this. */
  allowance?: ReactNode;
}) {
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<CheckState>('idle');
  const [status, setStatus] = useState('');
  const [manifest, setManifest] = useState<RepoManifest | null>(null);
  const [unread, setUnread] = useState(false);
  const [missing, setMissing] = useState<ImportMissing>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => { urlRef.current?.focus({ preventScroll: true }); }, []);

  const check = useCallback(async () => {
    const normalized = normalizeRepositoryUrl(url);
    setUrl(normalized);
    setMissing(null);
    setError(null);
    setState('checking');
    setManifest(null);
    setStatus('Checking bot access…');
    const result = await checkRepo(normalized);
    if (!result.ok) {
      setState('error');
      setStatus(result.error);
      return;
    }
    setManifest(result.manifest);
    setUnread(result.unread);
    setState('ok');
    setStatus(`✓ usernode-bot has Write access to ${result.fullName}.`);
    // The name opens on the repo's own, unless one was already typed.
    const repoName = typeof result.manifest.name === 'string' ? result.manifest.name : '';
    if (repoName) setName((typed) => (typed.trim() ? typed : repoName));
  }, [url]);

  const go = useCallback(async () => {
    if (busy || busyRef.current) return;
    const gap = importMissing(state === 'ok', name);
    if (gap) {
      setMissing(gap);
      (gap === 'repo' ? urlRef.current : nameRef.current)?.focus({ preventScroll: true });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const failed = await submit({ repoUrl: normalizeRepositoryUrl(url), name: name.trim(), manifest: manifest || {} });
      if (failed) setError(failed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [busy, state, name, url, manifest, submit]);

  const note = state === 'ok' ? repoNote(manifest, unread) : null;
  return (
    <form data-make-import="" className={className} onSubmit={(e) => { e.preventDefault(); void go(); }}>
      {header}
      <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <div className={FIELD}>
          <label htmlFor="make-import-url" className={LABEL}>GitHub repo URL</label>
          <div className="flex items-center gap-2">
            <input
              ref={urlRef}
              id="make-import-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
              value={url}
              aria-describedby="make-import-status"
              onChange={(e) => {
                setUrl(e.target.value);
                // A new address is an unchecked one.
                setState('idle'); setStatus(''); setManifest(null); setUnread(false);
                setMissing(null); setError(null);
              }}
              // Leaving the field visibly canonicalises it (#1604: a bare
              // github.com/owner/repo gets its https://); Check and Import
              // it send the same normalised value even without a blur.
              onBlur={() => setUrl((typed) => normalizeRepositoryUrl(typed))}
              onKeyDown={(e) => {
                // Return checks the repo; once checked, it moves on to the name.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (state === 'ok') nameRef.current?.focus({ preventScroll: true });
                else void check();
              }}
              placeholder="github.com/owner/repo"
              className={`${INPUT} min-w-0 flex-1 font-mono text-[15px]`}
            />
            <button
              type="button"
              data-make-import-check=""
              onClick={() => { void check(); }}
              disabled={state === 'checking'}
              className="shrink-0 rounded-full bg-zinc-100 px-3.5 py-1.5 text-[14px] font-semibold text-zinc-900 disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {state === 'ok' ? 'Re-check' : 'Check'}
            </button>
          </div>
          <p
            id="make-import-status"
            role="status"
            data-import-state={state}
            className={state === 'error' || missing === 'repo' ? NEEDED : state === 'ok' ? 'pb-1 text-xs text-emerald-700 dark:text-emerald-400' : HINT}
          >
            {state === 'checking' ? <SpinnerArcIcon className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin align-[-2px]" aria-hidden="true" /> : null}
            {missing === 'repo' && state !== 'error' ? 'Check the repo first.' : (status || 'Invite usernode-bot to the repo first (Write access on an organization repo).')}
          </p>
        </div>
        <div className={FIELD}>
          <label htmlFor="make-import-name" className={LABEL}>What should we call it?</label>
          <input
            ref={nameRef}
            id="make-import-name"
            type="text"
            autoComplete="off"
            enterKeyHint="go"
            value={name}
            aria-describedby="make-import-name-hint"
            onChange={(e) => { setName(e.target.value); setMissing(null); setError(null); }}
            placeholder="For example, Sunday Run Club"
            className={INPUT}
          />
          {missing === 'name'
            ? <p id="make-import-name-hint" role="alert" className={NEEDED}>Give it a name to import it. You can change it later.</p>
            : <p id="make-import-name-hint" className={HINT}>It's your group's name too. You can change it later.</p>}
        </div>
      </div>
      {note ? <p data-make-import-note="" className="mt-2 px-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{note}</p> : null}
      {allowance}
      {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="grow" />
      <Button
        type="submit"
        disabled={busy || blocked}
        layout="full"
        variant="pillAccent"
        size="pillLg"
        ink="solidLate"
        className="mt-6 flex items-center justify-center disabled:opacity-50"
      >
        {busy ? 'Importing…' : 'Import it'}
      </Button>
      <p className="mt-3 text-center">
        <button type="button" data-make-describe="" onClick={onDescribe} className="text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400">
          Describe a new project instead
        </button>
      </p>
    </form>
  );
}
