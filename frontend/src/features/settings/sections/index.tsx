/**
 * Every [data-settings-section] pane of the #settings screen, in the order the
 * shell has always emitted them (#1081 chunk D).
 *
 * There are SIXTEEN of them, one per entry in Settings.SECTIONS. It was
 * fifteen until #1336 added `username`; the count coincidentally matches what
 * #1081 claimed all along, which it reached by a different (wrong) route. The
 * registry, the shell and tests/settings-screen.test.js (which parses SECTIONS
 * out of settings.js and asserts a wrapper per key) are the authority.
 *
 * This file is the MARKUP half of the settings screen. Behaviour stays in
 * ./settings.js — the module binds every control below by id, ONCE, and the
 * chassis in ../index.tsx only ever toggles `hidden` on the wrappers. That
 * split is load-bearing:
 *
 *  - a pane must never be innerHTML-rebuilt, or the id-bound listeners on the
 *    controls inside it silently stop firing. React re-rendering one of these
 *    subtrees would be the same failure, so every component here is STATIC:
 *    no state, no props, no effects. They render once, at hydration, and are
 *    never reconciled again.
 *  - each wrapper ships `hidden`, exactly as the hand-written shell did, and
 *    the router unhides exactly one. That is the SECTION-ROUTING hidden.
 *  - #wallet-section, #settings-usernode-section and #settings-admin-section
 *    carry a SECOND, inner `hidden`. That one is a CAPABILITY GATE, owned by
 *    settings.js and read back by Settings._visibleSections() to decide menu
 *    membership. The two concepts are deliberately separate — collapsing them
 *    would make an ungated section unreachable the moment its wrapper hid.
 */

import { AdminPreviewSection } from './admin-preview';
import { AgentFilesSection } from './agent-files';
import { AlertsSection } from './alerts';
import { ApiKeySection } from './api-key';
import { AppAiSection } from './app-ai';
import { CliSection } from './cli';
import { ConnectorsSection } from './connectors';
import { DevConsoleSection } from './dev-console';
import { ExperimentalSection } from './experimental';
import { HomePanelsSection } from './home-panels';
import { LanguageSection } from './language';
import { OpenRouterSection } from './openrouter';
import { PasswordSection } from './password';
import { UsernameSection } from './username';
import { UsernodeSection } from './usernode';
import { WalletSection } from './wallet';

export function SettingsSections() {
  return (
    <>
      <ApiKeySection />
      <ConnectorsSection />
      <OpenRouterSection />
      <AppAiSection />
      <AgentFilesSection />
      <UsernameSection />
      <PasswordSection />
      <WalletSection />
      <LanguageSection />
      <AlertsSection />
      <HomePanelsSection />
      <CliSection />
      <DevConsoleSection />
      <ExperimentalSection />
      <UsernodeSection />
      <AdminPreviewSection />
    </>
  );
}
