/**
 * The shell's dialogs, one component per modal root.
 *
 * `Dialogs` renders them in the order Shell.tsx used to spell them out
 * inline. Order is load-bearing twice over: the prerendered public/index.html
 * is compared byte-for-byte against what the hand-written shell shipped, and
 * `tests/baselines/shell-markup.json` pins the id inventory that dapp.json's
 * declared checks select against.
 *
 * #1078 chunk A converted the markup and left every one of these static,
 * because `PlatformUI.adoptStaticModal` moved their cards out of the DOM at
 * open time and a React re-render would have reconciled against the wrong
 * parent. Chunk I brought that lift inside React
 * (`frontend/src/lib/static-modal.ts`, driven by `./use-dialog`), so all of
 * them are stateful now and the open/close/submit behaviour lives here rather
 * than in app.js, app-view.js and the retired public/js/app-secrets.js.
 *
 * The create-project dialog (#create-modal) was the first of the nine and is
 * gone: the Create button opens "What do you want to make?"
 * (../first-session/make.tsx), which also imports a GitHub repo, and every
 * new project ends on its made screen. Its ids are recorded as retired in
 * tests/shell-id-inventory.test.js.
 *
 * Two of them — members and feedback — keep their logic in a sibling
 * controller module rather than in JSX. That is a deliberate application of
 * the repo's "a move, not a rewrite" rule, not an exception to the seam: both
 * still route their whole lifecycle through `useDialog`. Each component's
 * header gives the reason.
 */

import { ReportDialog } from './report';
import { AppSettingsDialog } from './app-settings';
import { AppNotificationsDialog } from './app-notifications';
import { RenameAppDialog } from './rename-app';
import { CloseIssueDialog } from './close-issue';
import { ForkAppDialog } from './fork-app';
import { ImportPrDialog } from './import-pr';
import { MembersDialog } from './members';
import { FeedbackDialog } from './feedback';
import { ShareDialog } from './share';
import { AppSecretsDialog } from './app-secrets';
import { BoardFiltersDialog } from './board-filters';
import { WalletRecoveryDialog } from './wallet-recovery';

export function Dialogs() {
  return (
    <>
      <RenameAppDialog />
      <CloseIssueDialog />
      <ForkAppDialog />
      <ImportPrDialog />
      <MembersDialog />
      <FeedbackDialog />
      <ShareDialog />
      <AppSecretsDialog />
      {/*
          Streamlined Concept: the Board's filter selects + "Waiting on you"
          toggle, moved off the filter bar into a dialog. New markup (no
          legacy baseline) appended LAST so the originals keep their byte
          positions in the prerendered document.
      */}
      <BoardFiltersDialog />
      {/*
          Native-only migration recovery. New markup appended last so every
          existing dialog keeps its byte position in the built document.
      */}
      <WalletRecoveryDialog />
      <AppSettingsDialog />
      <AppNotificationsDialog />
      <ReportDialog />
    </>
  );
}

export {
  RenameAppDialog,
  CloseIssueDialog,
  ForkAppDialog,
  ImportPrDialog,
  MembersDialog,
  FeedbackDialog,
  ShareDialog,
  AppSecretsDialog,
  BoardFiltersDialog,
  WalletRecoveryDialog,
};
