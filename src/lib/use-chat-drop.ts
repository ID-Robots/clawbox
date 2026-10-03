"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import {
  CHAT_DROP_MAX_DEPTH,
  CHAT_DROP_MAX_FILES,
  classifyStagingFailure,
  newDropBatchId,
  planChatDrop,
  type ChatAttachment,
  type DroppedFile,
  type PlannedFolder,
  type StagingFailure,
} from "./chat-attachments";
import { dragHasFiles, readDroppedItems } from "./dropped-files";

// ── Drag-and-drop into the chat composer ────────────────────────────────────
//
// Shared by both composers — the desktop's mascot chat (ChatPopup) and the
// full-page chat (ChatApp) — so what a drop accepts, how a folder is staged and
// how progress is shown cannot drift between them. Loose files go through the
// composer's OWN staging function, the one the file picker and a paste use, so
// a dropped picture and a picked one are the same attachment; a folder is
// staged here, file by file into one batch, and handed back as one folder
// attachment once every file has landed.

/** Something on its way to the box, shown as a chip while it travels. */
export interface ChatUpload {
  id: string;
  /** The file's or folder's name; empty while a drop is still being read. */
  name: string;
  kind: "file" | "folder" | "reading";
  /** Files in it, and how many have landed (a single file is 1 and 0). */
  total: number;
  done: number;
}

export interface ChatUploadHandle {
  id: string;
  /** One more file landed. */
  advance(): void;
  /** Take the chip away — landed, failed or cancelled. */
  end(): void;
}

export interface ChatUploadTracker {
  uploads: ChatUpload[];
  begin(name: string, kind: ChatUpload["kind"], total?: number, controller?: AbortController): ChatUploadHandle;
  /** Stop a folder that is still uploading; what already landed stays staged for the sweep. */
  cancel(id: string): void;
}

/** The chips for everything in flight. `begin` and `cancel` are stable across renders. */
export function useChatUploads(): ChatUploadTracker {
  const [uploads, setUploads] = useState<ChatUpload[]>([]);
  const seq = useRef(0);
  const controllers = useRef(new Map<string, AbortController>());

  const begin = useCallback((name: string, kind: ChatUpload["kind"], total = 1, controller?: AbortController): ChatUploadHandle => {
    seq.current += 1;
    const id = `upload-${seq.current}`;
    if (controller) controllers.current.set(id, controller);
    setUploads((prev) => [...prev, { id, name, kind, total, done: 0 }]);
    return {
      id,
      advance: () => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, done: Math.min(u.total, u.done + 1) } : u))),
      end: () => {
        controllers.current.delete(id);
        setUploads((prev) => prev.filter((u) => u.id !== id));
      },
    };
  }, []);

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  // A composer that goes away stops what it started.
  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const controller of live.values()) controller.abort();
      live.clear();
    };
  }, []);

  return { uploads, begin, cancel };
}

/** Files of one folder in flight at once: enough to keep a LAN busy, few enough not to queue the box. */
const FOLDER_UPLOAD_CONCURRENCY = 3;

type StagedOne = { ok: true; root: string | null } | { ok: false; status?: number; payload: unknown };

async function stageFolderFile(file: DroppedFile, batch: string, signal: AbortSignal): Promise<StagedOne> {
  // The two fields go AHEAD of the file: the route reads them only before the
  // file part starts, so they decide where the bytes land.
  const form = new FormData();
  form.append("batch", batch);
  form.append("relativePath", file.relativePath);
  form.append("file", file.file, file.file.name);
  try {
    const res = await fetch("/setup-api/chat/attachments", { method: "POST", body: form, signal });
    const json = (await res.json().catch(() => ({}))) as { root?: unknown };
    if (!res.ok) return { ok: false, status: res.status, payload: json };
    const root = typeof json.root === "string" && json.root.trim() ? json.root.trim() : null;
    return { ok: true, root };
  } catch {
    // No status: the request never completed (or was cancelled). The thrown
    // error is never shown — it can carry the request URL.
    return { ok: false, payload: null };
  }
}

export interface ChatDropOptions {
  /** Whether a drop is taken at all — the composer is connected and this box takes attachments. */
  enabled: boolean;
  caps: { canAttachImages: boolean; canAttachDocuments: boolean };
  /** The composer's own staging for loose files (the picker's and the paste's). */
  stageFiles: (files: File[]) => void;
  /** A dropped folder, staged whole. */
  onFolderStaged: (attachment: ChatAttachment) => void;
  /** What the drop could not take, for the composer's error line. */
  onError: (failure: StagingFailure & { file: string }) => void;
  /** The composer's upload generation: bumped when it is closed, so a late folder is not resurrected. */
  generationRef: MutableRefObject<number>;
  tracker: ChatUploadTracker;
}

export interface ChatDrop {
  /** A drag of files is over the composer: show the drop target. */
  dragActive: boolean;
  dropHandlers: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
}

export function useChatFileDrop(opts: ChatDropOptions): ChatDrop {
  const [dragActive, setDragActive] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses; the target
  // is lit while the count of entered-but-not-left elements is above zero.
  const depth = useRef(0);
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  const uploadFolder = useCallback(async (folder: PlannedFolder) => {
    const { tracker, generationRef, onFolderStaged, onError } = optsRef.current;
    const generation = generationRef.current;
    const isCurrent = () => optsRef.current.generationRef.current === generation;
    const controller = new AbortController();
    const chip = tracker.begin(folder.name, "folder", folder.files.length, controller);
    const batch = newDropBatchId();
    // Written by the workers below; declared through `as` so the compiler does
    // not narrow them to their initial null across the awaits.
    let root = null as string | null;
    let failed = 0;
    let firstFailure = null as { status?: number; payload: unknown } | null;
    let next = 0;
    const worker = async () => {
      while (next < folder.files.length && !controller.signal.aborted) {
        const file = folder.files[next];
        next += 1;
        const staged = await stageFolderFile(file, batch, controller.signal);
        if (controller.signal.aborted) return;
        if (staged.ok) {
          root ??= staged.root;
        } else {
          failed += 1;
          firstFailure ??= { status: staged.status, payload: staged.payload };
          // A session that expired fails every file after it the same way.
          if (staged.status === 401 || staged.status === 403) controller.abort();
        }
        chip.advance();
      }
    };
    await Promise.all(Array.from({ length: Math.min(FOLDER_UPLOAD_CONCURRENCY, folder.files.length) }, worker));
    const cancelled = controller.signal.aborted && !(firstFailure && (firstFailure.status === 401 || firstFailure.status === 403));
    chip.end();
    if (cancelled || !isCurrent()) return;
    if (!root) {
      const failure = firstFailure ?? { status: undefined, payload: null };
      onError({ ...classifyStagingFailure(failure.status, failure.payload), file: folder.name });
      return;
    }
    const total = folder.files.length + folder.left;
    const missing = failed + folder.left;
    if (missing > 0) {
      onError({ reason: "folderPartial", detail: null, file: folder.name, params: { count: missing, total } });
    }
    onFolderStaged({
      name: folder.name,
      path: root,
      type: "inode/directory",
      kind: "folder",
      fileCount: folder.files.length - failed,
    });
  }, []);

  const handleDrop = useCallback(async (dt: DataTransfer) => {
    const { tracker, caps, stageFiles, onError } = optsRef.current;
    // Reading a big tree takes a moment; a chip says the drop was taken.
    const reading = tracker.begin("", "reading");
    let items;
    try {
      items = await readDroppedItems(dt, { maxFiles: CHAT_DROP_MAX_FILES, maxDepth: CHAT_DROP_MAX_DEPTH });
    } finally {
      reading.end();
    }
    const plan = planChatDrop(items, caps);
    if (plan.refusal) onError(plan.refusal);
    if (plan.files.length > 0) stageFiles(plan.files);
    for (const folder of plan.folders) void uploadFolder(folder);
  }, [uploadFolder]);

  // Every file drag over the chat stops HERE: the desktop under it has a drop
  // zone of its own ("saved to Downloads") that would otherwise light up over
  // the chat's, and — never seeing the drop the chat takes — stay lit.
  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.stopPropagation();
    if (!optsRef.current.enabled) return;
    e.preventDefault();
    depth.current += 1;
    setDragActive(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    // Taken either way: a file let go over a chat that is not taking any
    // (still connecting, or a box with no attachments at all) must not fall
    // through to the browser, which opens it and navigates the desktop away.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = optsRef.current.enabled ? "copy" : "none";
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  }, []);

  const onDrop = useCallback((e: DragEvent<HTMLElement>) => {
    depth.current = 0;
    setDragActive(false);
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (optsRef.current.enabled) void handleDrop(e.dataTransfer);
  }, [handleDrop]);

  // A composer switched off mid-drag (disconnected) drops its target too.
  useEffect(() => {
    if (!opts.enabled) {
      depth.current = 0;
      setDragActive(false);
    }
  }, [opts.enabled]);

  return { dragActive, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
