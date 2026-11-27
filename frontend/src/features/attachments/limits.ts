/**
 * The attachment rules every message box follows (#6256): how many files one
 * message may carry, how large each kind of file may be, and which of a
 * drop's or a pick's files are taken, which are left out, and the one line
 * that says so.
 *
 * They lived in the Messages composer until the blank thread with Homeroom
 * bot grew the same drop zone, "+" and paste. Two copies of a cap drift: the
 * second one keeps the old number the first one was fixed away from. So the
 * count, the per-type ceiling and the staging are here, and each composer
 * keeps only its own upload loop (the Messages one also saves to a draft
 * scope, which a blank thread has none of).
 */

import { refusalSummary } from './refusal-summary';

export const MAX_ATTACHMENTS = 4;

/** The ceiling for one file, by what it is: the image, the text, the archive, the rest. */
export function attachmentLimit(file: File): number {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return 4 * 1024 * 1024;
  if (/\.(txt|md|markdown|json|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|html?|py|rb|rs|go|java|kt|swift|dart|sh|sql|diff|patch)$/i.test(name) || file.type.startsWith('text/')) return 200 * 1024;
  if (name.endsWith('.zip') || file.type === 'application/zip') return 20 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

/** What a composer's catalog gives it; a whole message with its parameters. */
type Translate = (id: string, values?: Record<string, unknown>) => string;

/**
 * Stage a drop or a pick against what the composer already holds (`held` is
 * the attached files plus the uploads still running): the files to upload,
 * and the line naming the ones left out — the first reason, and how many
 * more went with it (#4065). A pick with no room at all uploads nothing and
 * says so. `limitOf` is the ceiling for one file where the place's server
 * has its own (a project's chat, `chatAttachmentLimit`).
 */
export function stageFiles(files: File[], held: number, t: Translate, limitOf: (file: File) => number = attachmentLimit): { upload: File[]; refused: string } {
  const room = Math.max(0, MAX_ATTACHMENTS - held);
  const selected = files.slice(0, room);
  if (!selected.length) return { upload: [], refused: t('messages:composer.attachLimit', { count: MAX_ATTACHMENTS }) };
  const tooLarge = selected.filter((file) => file.size > limitOf(file));
  const cut = files.length - selected.length;
  const firstReason = tooLarge.length
    ? t('messages:composer.fileTooLarge', { file: tooLarge[0].name })
    : (cut ? t('messages:composer.attachLimit', { count: MAX_ATTACHMENTS }) : '');
  const refused = refusalSummary(firstReason, tooLarge.length + cut - 1);
  return { upload: selected.filter((file) => !tooLarge.includes(file)), refused };
}

/**
 * The ceiling a project's chat takes for one file (src/services/attachments.js
 * validateChatUpload): an image, a Markdown or HTML page, a short text, and
 * anything else. Its box (features/group-chat/composer.tsx) stages with it.
 */
export function chatAttachmentLimit(file: File): number {
  const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 4 * 1024 * 1024;
  if (ext === 'md' || ext === 'markdown') return 512 * 1024;
  if (ext === 'html' || ext === 'htm') return 2 * 1024 * 1024;
  return 10 * 1024 * 1024;
}
