import { Button } from '@/components/ui/button';
import { CliSetupGuide } from '../settings/cli-setup-guide';

export interface OwnToolsGuideView {
  prompt: string;
  resumeHtml: string;
  canImport: boolean;
}

/** The same setup card as Settings, with this session's brief and context. */
export function OwnToolsGuide({ view }: { view: OwnToolsGuideView }) {
  return (
    <div className="dc-launchpad" data-launchpad="own-tools-pr">
      {view.resumeHtml ? <div dangerouslySetInnerHTML={{ __html: view.resumeHtml }} /> : null}
      <CliSetupGuide
        id="dc-cli-setup-guide"
        proposalPrompt={view.prompt}
        promptHelp="Copy this prompt into your agent. It includes this app and any work already started; fill in any remaining placeholders."
      />
      {view.canImport ? (
        <div className="px-4 pb-4 text-xs text-zinc-500 dark:text-zinc-400">
          <p>Already built a pull request yourself?</p>
          <Button
            type="button" size="sm" variant="neutral" className="mt-2"
            data-launchpad-action="import"
            onClick={() => window.DevChat?._importOwnToolsPr()}
          >Import Feature from a PR</Button>
        </div>
      ) : null}
    </div>
  );
}
