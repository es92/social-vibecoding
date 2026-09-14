/**
 * Shared local coding-agent setup for Settings and the own-tools launchpad.
 *
 * This guide is static section content, not a credential-list state. Keeping
 * it outside `#cli-tokens-list` means it remains visible while capability
 * detection is pending, when staging deliberately disables the real token
 * API, and when the account already has credentials.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

const REPOSITORY_SETUP = `git clone https://github.com/Usernode-Labs/social-vibecoding.git
cd social-vibecoding`;
const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';
const PROPOSAL_PROMPT = 'Create a proposal for <app name> that <describe the change you want>.';

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

function CopyableCode({ label, value }: { label: string; value: string }) {
  const [buttonLabel, setButtonLabel] = useState('Copy');
  return (
    <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2 text-xs font-mono text-zinc-700 dark:text-zinc-300"><code>{value}</code></pre>
      <Button
        type="button"
        layout="shrink"
        variant="unstyled"
        size="none"
        ink="none"
        className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center border-l border-zinc-200 dark:border-zinc-700 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          const ok = await ui()?.copyText?.(value);
          setButtonLabel(ok ? 'Copied' : 'Copy failed');
          if (!ok) ui()?.toast?.('Couldn’t copy. Select the text and copy it manually', { error: true });
          setTimeout(() => setButtonLabel('Copy'), 1500);
        }}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

function SetupStep({ n, title, children }: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-950 text-xs font-semibold text-violet-700 dark:text-violet-300" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</h4>
        {children}
      </div>
    </li>
  );
}

export function CliSetupGuide({
  id = 'cli-setup-guide',
  proposalPrompt = PROPOSAL_PROMPT,
  promptHelp = 'Replace the placeholders with the app and change you have in mind, then send the prompt.',
}: { id?: string; proposalPrompt?: string; promptHelp?: string } = {}) {
  return (
    <div id={id} className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Set up a local coding agent</h3>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        Start Codex or Claude Code from a local checkout and ask it to create a proposal.
      </p>
      <ol className="mt-4 space-y-4">
        <SetupStep n={1} title="Clone the repository">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Clone Homeroom and enter the checkout.
          </p>
          <CopyableCode label="repository setup commands" value={REPOSITORY_SETUP} />
        </SetupStep>
        <SetupStep n={2} title="Start your coding agent">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Run either Codex or Claude Code from the repository directory.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Codex</div>
              <CopyableCode label="Codex command" value={CODEX_COMMAND} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Claude Code</div>
              <CopyableCode label="Claude Code command" value={CLAUDE_COMMAND} />
            </div>
          </div>
        </SetupStep>
        <SetupStep n={3} title="Ask it to create a proposal">
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {promptHelp}
          </p>
          <CopyableCode label="example proposal prompt" value={proposalPrompt} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Follow the agent&rsquo;s instructions. It will ask you to authorize access on a Homeroom web page; review and approve the request there, then return to your terminal.
          </p>
        </SetupStep>
      </ol>
    </div>
  );
}
