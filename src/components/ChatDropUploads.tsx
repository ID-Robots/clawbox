"use client";

import type { ChatUpload } from "@/lib/use-chat-drop";
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_DROP_MAX_BYTES, CHAT_DROP_MAX_FILES } from "@/lib/chat-attachments";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The drop's limits as the overlay states them — the same numbers the drop is held to. */
const DROP_LIMITS = {
  count: CHAT_DROP_MAX_FILES,
  size: megabytes(CHAT_DROP_MAX_BYTES),
  fileSize: megabytes(CHAT_ATTACHMENT_MAX_BYTES),
};

/**
 * The drop target over a chat surface while files are dragged across it. It
 * never takes the pointer (`pointer-events: none`): the drag events stay with
 * the surface underneath, which is what owns the drop.
 */
export function ChatDropOverlay({ active, t }: { active: boolean; t: Translate }) {
  if (!active) return null;
  return (
    <div
      data-testid="chat-drop-overlay"
      aria-hidden="true"
      style={{
        position: 'absolute', inset: 6, zIndex: 30, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
        borderRadius: 14, border: '2px dashed rgba(249,115,22,0.65)',
        background: 'rgba(13,17,23,0.86)', color: '#fdba74',
        fontSize: 13, fontWeight: 500, textAlign: 'center', padding: 16,
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 40 }}>upload_file</span>
      <span>{t('chat.attachment.dropHint')}</span>
      <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>{t('chat.attachment.dropLimits', DROP_LIMITS)}</span>
    </div>
  );
}

/**
 * One chip per thing on its way to the box: a file with a spinner, a folder
 * with how many of its files have landed and a way to stop it. Its own strip
 * rather than a place in the attachment strip, so "attached" and "still
 * arriving" can never be mistaken for each other.
 */
export function ChatUploadChips({ uploads, onCancel, t }: {
  uploads: ChatUpload[];
  onCancel: (id: string) => void;
  t: Translate;
}) {
  if (uploads.length === 0) return null;
  return (
    <div
      data-testid="chat-uploads"
      role="status"
      aria-live="polite"
      style={{ padding: '6px 14px 0', display: 'flex', gap: 6, flexWrap: 'wrap', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}
    >
      {uploads.map((u) => {
        const label = u.kind === 'reading'
          ? t('chat.attachment.reading')
          : u.kind === 'folder'
            ? t('chat.attachment.uploadingFolder', { name: u.name, done: u.done, total: u.total })
            : t('chat.attachment.uploading', { name: u.name });
        const pct = u.total > 0 ? Math.round((u.done / u.total) * 100) : 0;
        return (
          <div
            key={u.id}
            data-testid="chat-upload"
            data-kind={u.kind}
            title={label}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 8,
              background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.25)',
              fontSize: 11, color: '#fdba74', maxWidth: 240,
            }}
          >
            <span
              className={`material-symbols-rounded${u.kind === 'folder' ? '' : ' motion-safe:animate-spin'}`}
              aria-hidden="true"
              style={{ fontSize: 14 }}
            >
              {u.kind === 'folder' ? 'folder' : 'progress_activity'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {u.kind === 'reading' ? label : u.name}
            </span>
            {u.kind === 'folder' && (
              <>
                <span
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={u.total}
                  aria-valuenow={u.done}
                  style={{ width: 48, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)', overflow: 'hidden', flexShrink: 0 }}
                >
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: '#f97316', transition: 'width 0.2s' }} />
                </span>
                <span style={{ color: 'rgba(255,255,255,0.55)', flexShrink: 0 }}>{u.done}/{u.total}</span>
                <button
                  type="button"
                  onClick={() => onCancel(u.id)}
                  aria-label={t('chat.attachment.cancelUpload', { name: u.name })}
                  title={t('chat.attachment.cancelUpload', { name: u.name })}
                  style={{ background: 'none', border: 'none', color: '#f97316', cursor: 'pointer', padding: 0, display: 'flex', flexShrink: 0 }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
