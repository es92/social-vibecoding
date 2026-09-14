import { useEffect, useMemo, useRef, useState } from 'react';

import { ArrowUpIcon, ArrowUpTrayIcon, PaperClipIcon } from '@/components/ui/icons';
import * as api from './api';
import { draftFor, notifyTyping, replyFor, send, setDraft, setReply, takePendingShare, useMessagesSnapshot } from './store';
import type { MessageAttachment, SharedObjectReference } from './types';
import { fileSize } from './format';
import { useAutoGrow } from '../../lib/use-auto-grow';

const MAX_ATTACHMENTS = 4;

function attachmentLimit(file: File): number {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return 4 * 1024 * 1024;
  if (/\.(txt|md|markdown|json|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|html?|py|rb|rs|go|java|kt|swift|dart|sh|sql|diff|patch)$/i.test(name) || file.type.startsWith('text/')) return 200 * 1024;
  if (name.endsWith('.zip') || file.type === 'application/zip') return 20 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

function objectLabel(object: SharedObjectReference): string {
  const app = object.appSlug ? `${object.appSlug} · ` : '';
  if (object.type === 'app') return `${app}App`;
  if (object.type === 'issue') return `${app}Issue #${object.issueNumber}`;
  if (object.type === 'governance') return `${app}Governance #${object.proposalId}`;
  if (object.type === 'spec') return `${app}Spec v${object.version} · session ${object.sessionId}`;
  return `${app}Proposal ${object.sessionId}`;
}

export function MessageComposer() {
  const snap = useMessagesSnapshot();
  const conversationId = snap.route.conversationId || 0;
  const active = snap.active;
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [object, setObject] = useState<SharedObjectReference | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // #1408: grow with the message, up to the max-height already in app.css.
  useAutoGrow(inputRef, value);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingStop = useRef<number | null>(null);
  const reply = replyFor(conversationId);

  useEffect(() => {
    setValue(draftFor(conversationId)); setAttachments([]); setObject(null); setError('');
  }, [conversationId]);

  useEffect(() => {
    const onSelected = (event: Event) => {
      const detail = (event as CustomEvent<SharedObjectReference>).detail;
      if (detail) { setObject(detail); inputRef.current?.focus(); }
    };
    const onShare = (event: Event) => {
      // A bare Messages screen is asking the user to choose a destination;
      // leave the one-shot in the store until a conversation route exists.
      if (!conversationId) return;
      const eventDetail = (event as CustomEvent<SharedObjectReference | null>).detail;
      // share() publishes synchronously when this composer is already mounted.
      // Consume its store fallback here so a later remount cannot reopen it.
      const pending = takePendingShare();
      const detail = pending === undefined ? eventDetail : pending;
      window.UsernodeReact?.dialogs?.messagesShare?.open(detail || undefined);
    };
    window.addEventListener('usernode:messages-object-selected', onSelected);
    window.addEventListener('usernode:messages-share', onShare);
    // An app/card share can navigate into Messages before this conversation
    // composer mounts. Consume that one-shot payload after listeners exist.
    if (conversationId) {
      const pending = takePendingShare();
      if (pending !== undefined) window.UsernodeReact?.dialogs?.messagesShare?.open(pending || undefined);
    }
    return () => {
      window.removeEventListener('usernode:messages-object-selected', onSelected);
      window.removeEventListener('usernode:messages-share', onShare);
    };
  }, [conversationId]);

  useEffect(() => () => {
    if (typingStop.current) window.clearTimeout(typingStop.current);
    notifyTyping(false);
  }, [conversationId]);

  const mention = useMemo(() => {
    const cursor = inputRef.current?.selectionStart ?? value.length;
    const prefix = value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/)?.[1];
    if (prefix === undefined) return null;
    return (active?.members || []).filter((member) => member.status === 'member'
      && member.username.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 6);
  }, [active?.members, value]);

  function updateValue(next: string) {
    const trimmed = next.slice(0, 8000);
    setValue(trimmed); setDraft(conversationId, trimmed);
    notifyTyping(true);
    if (typingStop.current) window.clearTimeout(typingStop.current);
    typingStop.current = window.setTimeout(() => notifyTyping(false), 2200);
  }

  function insertMention(username: string) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const before = value.slice(0, cursor).replace(/@([^\s@]*)$/, `@${username} `);
    const next = before + value.slice(cursor);
    updateValue(next);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(before.length, before.length); });
  }

  async function addFiles(files: File[]) {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length - uploading);
    const selected = files.slice(0, room);
    if (!selected.length) { setError(`You can attach up to ${MAX_ATTACHMENTS} files.`); return; }
    for (const file of selected) {
      if (file.size > attachmentLimit(file)) {
        setError(`${file.name} is too large for this file type.`);
        continue;
      }
      setUploading((count) => count + 1); setError('');
      try {
        const attachment = await api.uploadAttachment(conversationId, file);
        setAttachments((items) => [...items, attachment]);
      }
      catch (err) { setError(err instanceof Error ? err.message : `Couldn’t upload ${file.name}.`); }
      finally { setUploading((count) => Math.max(0, count - 1)); }
    }
  }

  async function submit() {
    if (sending || uploading || (!value.trim() && !attachments.length && !object)) return;
    setSending(true); setError(''); notifyTyping(false);
    try {
      await send({ content: value.trim(), attachmentIds: attachments.map((item) => item.id), object: object || undefined });
      setValue(''); setAttachments([]); setObject(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) { setError(err instanceof Error ? err.message : 'Your message wasn’t sent.'); }
    finally { setSending(false); }
  }

  if (!active || active.membershipStatus !== 'member') return null;
  if (!active.canSend) return <div className="messages-composer-disabled platform-safe-bar">You can’t send messages in this conversation.</div>;

  return (
    <div className={`messages-composer platform-safe-bar ${dragging ? 'messages-composer-dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
      {/* The white card. The bar around it is what carries the home-indicator
          inset (`platform-safe-bar`), so the card keeps its own padding on a
          notched phone instead of growing a tall blank foot. */}
      <div className="messages-composer-card">
      {reply ? <div className="messages-reply-draft"><div className="min-w-0"><span className="font-semibold">Replying to @{reply.sender.username}</span><p className="truncate">{reply.content || 'Attachment'}</p></div><button type="button" onClick={() => setReply(conversationId, null)} aria-label="Cancel reply">×</button></div> : null}
      {object ? <div className="messages-pending-object"><span aria-hidden="true">◆</span><span className="truncate">{objectLabel(object)}</span><button type="button" onClick={() => setObject(null)} aria-label="Remove shared item">×</button></div> : null}
      {attachments.length || uploading ? <div className="dc-attach-strip dc-attach-strip-active">{attachments.map((item) => <div key={item.id} className="dc-attach-item"><div className="min-w-0"><div className="dc-attach-name">{item.name}</div><div className="dc-attach-size">{fileSize(item.size)}</div></div><button type="button" className="dc-attach-remove" onClick={() => setAttachments((items) => items.filter((candidate) => candidate.id !== item.id))} aria-label={`Remove ${item.name}`}>×</button></div>)}{uploading ? <span className="dc-attach-uploading">Uploading {uploading}…</span> : null}</div> : null}
      {mention?.length ? <div className="messages-mention-menu" role="listbox">{mention.map((member) => <button key={member.id} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(member.username)}>@{member.username}</button>)}</div> : null}
      <div className="flex items-end gap-1.5">
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ''; }} />
        <button type="button" className="messages-composer-action" onClick={() => fileRef.current?.click()} disabled={attachments.length + uploading >= MAX_ATTACHMENTS} aria-label="Attach files" title="Attach files"><PaperClipIcon aria-hidden="true" /></button>
        <button type="button" className="messages-composer-action" onClick={() => window.UsernodeReact?.dialogs?.messagesShare?.open()} aria-label="Share Homeroom item" title="Share item"><ArrowUpTrayIcon aria-hidden="true" /></button>
        <textarea ref={inputRef} value={value} onChange={(event) => updateValue(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } else if (event.key === 'Escape' && reply) setReply(conversationId, null); }} onBlur={() => notifyTyping(false)} rows={1} maxLength={8000} placeholder="Message…" aria-label="Message" className="messages-composer-input" />
        <button type="button" onClick={() => void submit()} disabled={sending || !!uploading || (!value.trim() && !attachments.length && !object)} className="messages-send" aria-label="Send message">{sending ? '…' : <ArrowUpIcon aria-hidden="true" />}</button>
      </div>
      {error ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="mt-1 px-1 flex justify-end"><span className={`text-[10px] ${value.length > 7600 ? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{value.length ? `${value.length}/8000` : ''}</span></div>
      </div>
      {dragging ? <div className="messages-drop-overlay">Drop files to attach</div> : null}
    </div>
  );
}
