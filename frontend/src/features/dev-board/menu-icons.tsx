/**
 * The ⋯ menu's line icons, keyed by meaning (overnight UI audit D08,
 * the owner's decision of 2 Nov 2026).
 *
 * A card's or a request's ⋯ menu names each row's meaning with a key of
 * AppView.MENU_ICONS (public/js/app-view.js): `edit`, `priority`, `mute`…
 * Those keys used to resolve to a text glyph or a colour emoji (✎ ⚑ 🏷 🔕),
 * so one menu mixed monochrome marks with coloured stickers whose colours
 * meant nothing, where every other sheet (the hub's ⋯) draws the shell's
 * line icons. The keys stay the vocabulary; this table draws each from
 * @/components/ui/icons.tsx, in `currentColor`, so a danger row's icon is
 * red with its label.
 *
 * Two consumers, one table:
 *   - the desktop dropdown (./card-menu.tsx) renders `<MenuIcon name>`;
 *   - the touch action sheet is the native kit's, built by app-view.js from
 *     plain data. The kit takes artwork as `iconEl` (usernode-native v1's
 *     menu-row icons, the way the hub's ⋯ sheet hands it a cloned svg element), so
 *     `menuIconElement(key)` renders the same component into a detached
 *     node and hands back its svg element.
 */

import { createElement, type ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ArrowTopRightOnSquareIcon,
  BellIcon,
  BellSlashIcon,
  BoltIcon,
  ChartBarIcon,
  ChatIcon,
  CheckIcon,
  CodeIcon,
  DescriptionIcon,
  EllipsisHorizontalIcon,
  ExpandIcon,
  EyeIcon,
  FlagIcon,
  HandRaisedIcon,
  LockIcon,
  NoSymbolIcon,
  PencilSparklesIcon,
  PencilSquareIcon,
  PhotoIcon,
  ReplyArrowIcon,
  ShareIcon,
  SparklesIcon,
  StarIcon,
  TagIcon,
  TerminalIcon,
  UserCheckIcon,
  XIcon,
  type IconProps,
} from '@/components/ui/icons';

/** Every AppView.MENU_ICONS key, drawn. tests/dev-card-overflow-menu.test.js holds the two key lists equal. */
export const MENU_ICON_COMPONENTS: Record<string, ComponentType<IconProps>> = {
  merge: BoltIcon,
  session: TerminalIcon,
  withdraw: XIcon,
  undo: ReplyArrowIcon,
  unpromote: ArrowLeftIcon,
  kudos: StarIcon,
  explore: SparklesIcon,
  generate: PencilSparklesIcon,
  retry: ArrowPathIcon,
  checks: CheckIcon,
  visuals: PhotoIcon,
  github: ArrowTopRightOnSquareIcon,
  code: CodeIcon,
  priority: FlagIcon,
  category: TagIcon,
  assignee: UserCheckIcon,
  progress: HandRaisedIcon,
  clear: XIcon,
  close: NoSymbolIcon,
  visible: EyeIcon,
  hide: LockIcon,
  chat: ChatIcon,
  archive: ArchiveBoxIcon,
  campaign: ChartBarIcon,
  open: ExpandIcon,
  details: DescriptionIcon,
  edit: PencilSquareIcon,
  share: ShareIcon,
  notify: BellIcon,
  mute: BellSlashIcon,
  move: ArrowsRightLeftIcon,
  default: EllipsisHorizontalIcon,
};

function iconFor(name: string | null | undefined): ComponentType<IconProps> {
  return (name && MENU_ICON_COMPONENTS[name]) || MENU_ICON_COMPONENTS.default;
}

/** One row's icon. Decorative: the row's label is its whole accessible name. */
export function MenuIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  return createElement(iconFor(name), { className, 'aria-hidden': 'true' } as IconProps);
}

/**
 * The same icon as a detached svg element, for the kit's action sheet (`iconEl`).
 * No class: the kit sizes and inks its own row icons. Null where there is no
 * document (the prerender), and the caller then falls back to a plain row.
 */
export function menuIconElement(name: string | null | undefined): Element | null {
  if (typeof document === 'undefined') return null;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(iconFor(name), { 'aria-hidden': 'true' } as IconProps)));
    const svg = host.firstElementChild;
    return svg ? svg.cloneNode(true) as Element : null;
  } catch {
    return null;
  } finally {
    root.unmount();
  }
}
