/**
 * The twenty-four admin section modules, in one lazily-imported barrel.
 *
 * Each of these is a side-effect import: the module publishes itself on
 * `window.<Name>` and AdminConsole._renderModule looks it up there by the
 * name in SECTION_MODULES. Nothing here has an export anybody reads, which
 * is exactly why they could sit in ./index.tsx as bare imports — and why
 * moving them costs no call-site changes.
 *
 * They were 422KB of the shell's 1.75MB bundle (24%), downloaded, parsed and
 * kept in memory by every visitor so that admins could open a console behind
 * an `App.user.isAdmin` gate. The chassis stays static — AdminScreen renders
 * #admin-root, #admin-nav-desktop, #admin-section-content and the
 * temporary-password dialog, all of which are in the prerendered document and
 * in tests/baselines/shell-markup.json, and none of which move.
 *
 * This split is possible because the sections already mount through a runtime
 * seam rather than through markup: AdminConsole._renderSection hands a section
 * its host and calls mod.render(host), and _teardownActiveSection calls
 * destroy() on the way out. A section's contents were never in the document
 * before it was opened; now its CODE is not either.
 */
import './admin-overview.tsx';
import './admin-codes.tsx';
import './admin-featured-apps.tsx';
import './admin-db-export.tsx';
import './admin-storage.tsx';
import './admin-model-costs.tsx';
import './admin-homeroom-bot.tsx';
import './admin-features.tsx';
import './admin-limits.tsx';
import './admin-users.tsx';
import './admin-support.tsx';
import './admin-reports.tsx';
import './admin-rollover.tsx';
import './admin-staging-reap.tsx';
import './admin-status.tsx';
import './admin-node.tsx';
import './admin-analytics.tsx';
import './admin-estimator.tsx';
import './admin-merges.tsx';
import './admin-gallery.tsx';
import './admin-campaigns.tsx';
import './admin-push.tsx';
import './admin-mail.tsx';
import './admin-e2e.tsx';
import './admin-topochain.js';
