"use client";

import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useMobileBack, usePhoneLayout } from "@/lib/mobile-back";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { fileExtension, fileIcon, formatSize, Icon } from "./file-icons";
import CodeEditor from "./CodeEditor";
import { languageForFile } from "@/lib/code-language";
import { useMayUseOwnerApis, useSessionUser } from "@/lib/use-session-user";
import {
  shouldShowBackupSuggestion,
  type BackupOverview,
  type FolderBackupSummary,
} from "@/lib/project-backup-shared";
import { BackupSuggestionCard, GitHubHelpDialog, ProjectBackupPanel, backupRowText } from "./ProjectBackup";
import {
  EMPTY_SELECTION,
  canMoveInto,
  clickSelection,
  isInsideOrSame,
  parentOf,
  selectAll,
  type FilesSelection,
} from "@/lib/files-selection";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number | null;
  modified: string;
  // Set only on recursive search results: path relative to the files root.
  // When absent, the entry lives in the currently-loaded directory.
  path?: string;
}

type ViewerKind = "text" | "image" | "pdf" | "video" | "audio" | "toobig" | "binary";

type ViewMode = "grid" | "list";

interface DialogState {
  type: "rename" | "mkdir" | "delete" | null;
  entry?: FileEntry;
  /** A delete of a multi-selection: every item it removes. */
  entries?: FileEntry[];
  value?: string;
}

/** A move the destination refused over names it already holds, waiting on "keep both" or "skip". */
interface MoveConflict {
  paths: string[];
  dest: string;
  conflicts: { path: string; name: string }[];
}

function isMoveConflictItem(v: unknown): v is { path: string; name: string } {
  return !!v && typeof v === "object"
    && typeof (v as { path?: unknown }).path === "string"
    && typeof (v as { name?: unknown }).name === "string";
}

// ─── Dragging items ───────────────────────────────────────────────────────────

/** What a Files item carries while it is dragged: its browse-relative path(s), as JSON. */
const FILES_DRAG_TYPE = "application/x-clawbox-files";

/**
 * The paths being dragged right now, readable by EVERY Files window. A drop
 * target has to answer "can these land here?" during `dragover`, when the
 * browser lets it see the drag's types but not its data — and the drag may
 * have started in another Files window on the same desktop.
 */
let activeDragPaths: string[] | null = null;

function parseDragPaths(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((p) => typeof p === "string") ? parsed as string[] : null;
  } catch {
    return null;
  }
}

/**
 * Said after a move, delete or upload, so the OTHER open Files windows read
 * their folder again: an item dragged from one window into a folder in another
 * is moved by the window it was dropped on, and the one it left would
 * otherwise keep showing it.
 */
const FILES_CHANGED_EVENT = "clawbox:files-changed";

type ContextMenuState = {
  entry: FileEntry;
  x: number;
  y: number;
} | null;

/**
 * A folder the owner pinned to Projects (src/lib/project-folders.ts). `path`
 * is browse-relative, the same string `load()` takes.
 */
interface ProjectFolder {
  path: string;
  name: string;
  missing?: boolean;
}

/** What the window shows: a folder, or the owner's pinned project folders. */
type Place = "folder" | "projects";

function isProjectFolder(v: unknown): v is ProjectFolder {
  return !!v && typeof v === "object"
    && typeof (v as ProjectFolder).path === "string"
    && typeof (v as ProjectFolder).name === "string";
}

/**
 * The pinned folder `dir` is in (or is), deepest first — `projects` and
 * `projects/site` both pinned puts `projects/site/src` under the second. A
 * missing pin is no folder to be in.
 */
function projectRootOf(dir: string, folders: ProjectFolder[]): ProjectFolder | null {
  let best: ProjectFolder | null = null;
  for (const f of folders) {
    if (f.missing) continue;
    if (dir !== f.path && !dir.startsWith(`${f.path}/`)) continue;
    if (!best || f.path.length > best.path.length) best = f;
  }
  return best;
}

/** `/setup-api/files/<path>`, each segment encoded. */
function filesUrl(relPath: string): string {
  return `/setup-api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAVORITES = [
  { labelKey: "files.home", icon: "home", path: "" },
  { labelKey: "files.documents", icon: "description", path: "Documents" },
  { labelKey: "files.downloads", icon: "download", path: "Downloads" },
  { labelKey: "files.desktop", icon: "desktop_windows", path: "Desktop" },
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function downloadViaLink(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

// Parent directory of a root-relative search-result path ("a/b/c.txt" -> "a/b").
function parentDirOf(p?: string): string {
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// Stable identity for selection + React keys. In a folder listing the name is
// unique; in recursive search results two files can share a name across
// directories, so the full relative path is the unique key.
function entryId(e: FileEntry): string {
  return e.path ?? e.name;
}

// The Files WINDOW's width, not the viewport's. A desktop Files window opens
// 507 px wide on a 1920 px screen, where every Tailwind `sm:`/`md:` branch
// still answers "desktop": the 200 px sidebar stayed in flow, the list view's
// name column was left ~25 px (one letter per row) and the breadcrumb was
// squeezed to nothing at all. Measured, the way the Coding Agent measures the
// window it puts its own sidebar in.
const NARROW_WIDTH = 640;

/** A name, not a path: what a rename may be. The route refuses the rest. */
function isBareName(name: string): boolean {
  return !name.includes("/") && name !== "." && name !== "..";
}

// ─── File viewer kind detection ────────────────────────────────────────────────

// Anything bigger than this won't open in the in-browser text editor — it would
// be sluggish and risks the gateway buffering a huge string. Such files fall
// back to a download prompt.
const TEXT_MAX = 2 * 1024 * 1024;

// The file-serving route reads the whole file into memory (no Range streaming),
// so cap inline media too — pointing a <video>/<img> at a multi-hundred-MB file
// would buffer it all into the Jetson's RAM. Above this, offer a download.
const MEDIA_MAX = 50 * 1024 * 1024;

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif"]);
const PDF_EXT = new Set(["pdf"]);
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);

function resolveViewerKind(name: string, size: number | null): ViewerKind {
  const ext = fileExtension(name);
  const media: ViewerKind | null = IMAGE_EXT.has(ext) ? "image"
    : PDF_EXT.has(ext) ? "pdf"
    : VIDEO_EXT.has(ext) ? "video"
    : AUDIO_EXT.has(ext) ? "audio"
    : null;
  if (media) return size != null && size > MEDIA_MAX ? "toobig" : media;
  if (size != null && size > TEXT_MAX) return "toobig";
  // Known-text, no-extension config/scripts, and unknown-but-small files all
  // attempt the text editor; a binary sniff after fetch reclassifies if needed.
  return "text";
}

// Cheap heuristic: a NUL byte or a high ratio of U+FFFD replacement chars (from
// decoding non-UTF-8 bytes as text) means this isn't editable text.
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  let replacement = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c === 0xfffd) replacement++;
  }
  return replacement > sample.length * 0.02;
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * `initialPath` is the browse-relative folder the window opens in — the
 * Coding Agent's "Open in Files" hands a project's folder through the
 * window's record; a plain Files window starts at home. `initialPlace`
 * "projects" opens on the owner's pinned project folders instead (the
 * desktop's Projects icon) — a path, when both are given, wins.
 */
export default function FilesApp({ initialPath = "", initialPlace }: { initialPath?: string; initialPlace?: "projects" } = {}) {
  const { t } = useT();
  const tr = useTr();
  const startsOnProjects = initialPlace === "projects" && !initialPath;
  const [place, setPlace] = useState<Place>(startsOnProjects ? "projects" : "folder");
  const [projects, setProjects] = useState<ProjectFolder[]>([]);
  const [suggestions, setSuggestions] = useState<ProjectFolder[]>([]);
  const [projectsState, setProjectsState] = useState<"loading" | "ready" | "error">("loading");
  const [projectsMax, setProjectsMax] = useState(50);
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  // Hidden by default — matches every desktop file manager. Persisted across
  // window reopens so the user's choice sticks. Reading lazily inside
  // useState's initializer guards against SSR (no `window` until mount).
  const [showHidden, setShowHiddenState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("clawbox.files.showHidden") === "1";
  });

  // The ref carries the current choice so the toggle can compute the next one
  // without a dependency, which is what the updater was being used for. A
  // React state updater is a pure function of the previous state — React is
  // entitled to run it twice — and this one wrote localStorage from inside it,
  // so the write happened once per render attempt rather than once per click.
  // It is idempotent, which is exactly why it went unnoticed. See
  // src/tests/unit/state-updater-purity.test.ts.
  //
  // The raw setter is renamed out of reach and every write goes through
  // `applyShowHidden`, so the mirror cannot be left behind by a writer that
  // forgets the ref line. A mirror kept in step by a convention is an invisible
  // LOST write, and the purity rule cannot see one: it reports side effects
  // INSIDE an updater, never a missing ref advance outside one.
  const showHiddenRef = useRef(showHidden);
  const applyShowHidden = useCallback((next: boolean) => {
    showHiddenRef.current = next;
    setShowHiddenState(next);
  }, []);
  const toggleShowHidden = useCallback(() => {
    const next = !showHiddenRef.current;
    applyShowHidden(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("clawbox.files.showHidden", next ? "1" : "0");
    }
  }, [applyShowHidden]);
  // Many items at once: click, Ctrl/⌘-click, Shift-click, Ctrl/⌘+A — see
  // src/lib/files-selection.ts for the rules.
  const [selection, setSelection] = useState<FilesSelection>(EMPTY_SELECTION);
  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);
  // A touch screen has no Ctrl key: "Select" in an item's menu makes a tap
  // add or remove items until the selection is empty again.
  const [selectMode, setSelectMode] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ type: null });
  // The selection (or one item) on its way to "Move to…", and a move waiting
  // on the owner's answer about names the destination already holds.
  const [moveDialog, setMoveDialog] = useState<{ paths: string[]; entries: FileEntry[] } | null>(null);
  const [moveConflict, setMoveConflict] = useState<MoveConflict | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // The folder a drag is over — an item, a crumb or a sidebar place.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth >= 768 : true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // ─── The window's width ────────────────────────────────────────────────────

  const rootRef = useRef<HTMLDivElement>(null);
  // Always false to begin with, never `window.innerWidth < NARROW_WIDTH`: the
  // server has no window and renders the wide layout, so a phone-sized client
  // that seeded `true` handed React a first render that disagreed with the
  // markup it was hydrating — `data-narrow` set, columns dropped — which is a
  // hydration mismatch. The observer below measures the real element (this is
  // the WINDOW's width, not the screen's, so innerWidth was never the right
  // number anyway) and corrects it in the first commit after mount.
  const [narrow, setNarrow] = useState<boolean>(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? el.clientWidth;
        setNarrow(width < NARROW_WIDTH);
      });
      ro.observe(el);
    } catch { /* a stubbed observer with no observe(): the window stays wide */ }
    return () => { try { ro?.disconnect(); } catch { /* same stub */ } };
  }, []);

  // Below NARROW_WIDTH the sidebar covers the files instead of standing beside
  // them, so it is closed on the way in — the toolbar's menu button, which is
  // up whenever the sidebar is down, brings it back.
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrow.current) setSidebarOpen(false);
    wasNarrow.current = narrow;
  }, [narrow]);

  // ─── Status line ───────────────────────────────────────────────────────────

  // One clock for the whole line. Every message used to arm its own
  // uncancelled timer, so the 2 s clock a "Folder created" started wiped the
  // ERROR that replaced it a moment later: the one message that has to stay
  // was the one that vanished. A message with no `ms` stays until the next
  // action replaces it.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback((msg: string | null, ms?: number) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = null;
    setStatusMsg(msg);
    if (msg && ms) {
      statusTimer.current = setTimeout(() => { statusTimer.current = null; setStatusMsg(null); }, ms);
    }
  }, []);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  // Search + viewer state
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  // Why the walk ended: "matches" (the cap — there are more) or "scanned"
  // (the tree was too big to finish, so parts of it were never looked at).
  // Two different sentences; one boolean said "first N shown" for both.
  const [searchStoppedBy, setSearchStoppedBy] = useState<"matches" | "scanned" | null>(null);
  const [viewer, setViewer] = useState<{ relPath: string; entry: FileEntry } | null>(null);
  // On a phone, Back walks up the folder tree one level per press (and closes
  // an open file or the covering sidebar first) instead of closing Files.
  const phoneLayout = usePhoneLayout();
  // Inside a pinned project the trail — and Back, and Up — start at the
  // project, not at the home folder it happens to live in: the assistant's
  // projects are three hidden folders down (`.openclaw/workspace/projects`),
  // and walking up through those is not the way the owner came in.
  const projectRoot = place === "folder" ? projectRootOf(currentPath, projects) : null;
  const folderDepth = currentPath.split("/").filter(Boolean).length;
  const backLevels = place === "projects"
    ? 0
    : projectRoot
      ? folderDepth - projectRoot.path.split("/").length + 1
      : folderDepth;
  useMobileBack(phoneLayout && backLevels > 0, () => goUp(), backLevels);
  useMobileBack(phoneLayout && narrow && sidebarOpen, () => setSidebarOpen(false));
  // An open file claims Back inside FileViewer, through its own attemptClose,
  // so unsaved edits get the discard prompt instead of being dropped.


  const dropZoneRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; entry: FileEntry } | null>(null);

  // ─── Load directory ────────────────────────────────────────────────────────

  // The folder on screen, readable from `load` without giving it a dependency
  // that would remake it on every navigation.
  const currentPathRef = useRef(currentPath);
  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelection(EMPTY_SELECTION);
    // A message with no clock is meant to outlast the ACTION it answers, not
    // the folder: "Error: Already exists" followed the owner two folders up
    // and stood over the new listing's count (sweep FT-1). Leaving the folder
    // clears the line; a reload of the same one that an ACTION fired — the
    // one "Folder created" arms just before it — keeps it. A reload the owner
    // asked for (the Refresh button) clears it at the button, not here.
    if (dir !== currentPathRef.current) showStatus(null);
    // Recursive results are scoped to one directory — drop them when we move
    // to another folder (the typed filter in `query` is kept and re-applies to
    // the new listing). navigateTo also closes the search bar for result dirs.
    setRecursive(false);
    setSearchResults([]);
    setSearchStoppedBy(null);
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      const sorted = [...(data.files as FileEntry[])].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
      setCurrentPath(dir);
      currentPathRef.current = dir;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [showStatus]);

  // The Projects view lists no folder, so a window that opens on it has none
  // to fetch until the owner picks one.
  useEffect(() => { if (!startsOnProjects) void load(initialPath); }, [load, initialPath, startsOnProjects]);

  // ─── Projects ──────────────────────────────────────────────────────────────

  // Read once on mount for the sidebar, and again whenever the Projects view
  // is opened (the suggestions follow what is on the disk).
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/project-folders");
      const data = await res.json().catch(() => null) as { folders?: unknown; suggestions?: unknown; max?: unknown } | null;
      if (!res.ok || !data) throw new Error(String(res.status));
      setProjects(Array.isArray(data.folders) ? data.folders.filter(isProjectFolder) : []);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions.filter(isProjectFolder) : []);
      if (typeof data.max === "number") setProjectsMax(data.max);
      setProjectsState("ready");
    } catch {
      setProjectsState("error");
    }
  }, []);
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  /** Why a pin was refused, in the owner's words; the route's own text is the last resort. */
  const pinRefusal = (code: unknown, message: unknown): string => {
    switch (code) {
      case "outside_root": return t("files.pinOutsideRoot");
      case "protected": return t("files.pinProtected");
      case "not_found": return t("files.pinNotFound");
      case "not_directory": return t("files.pinNotDirectory");
      case "is_root": return t("files.pinIsRoot");
      case "too_many": return t("files.pinTooMany", { max: projectsMax });
      default: return t("files.errorPrefix", { message: typeof message === "string" && message ? message : t("files.projectsLoadError") });
    }
  };

  /** Pin a folder; answers the refusal it showed, or null when it landed. */
  const pinFolder = async (input: string): Promise<string | null> => {
    try {
      const res = await fetch("/setup-api/project-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: input }),
      });
      const data = await res.json().catch(() => ({})) as { folder?: unknown; folders?: unknown; code?: unknown; error?: unknown };
      if (!res.ok) {
        const msg = pinRefusal(data.code, data.error);
        showStatus(msg);
        return msg;
      }
      if (Array.isArray(data.folders)) setProjects(data.folders.filter(isProjectFolder));
      const folder = isProjectFolder(data.folder) ? data.folder : null;
      if (folder) setSuggestions((s) => s.filter((x) => x.path !== folder.path));
      showStatus(t("files.pinned", { name: folder?.name ?? input }), 2500);
      return null;
    } catch (e) {
      const msg = pinRefusal(null, e instanceof Error ? e.message : null);
      showStatus(msg);
      return msg;
    }
  };

  const unpinFolder = async (folder: ProjectFolder) => {
    try {
      const res = await fetch(`/setup-api/project-folders?path=${encodeURIComponent(folder.path)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { folders?: unknown; error?: unknown };
      if (!res.ok) { showStatus(t("files.errorPrefix", { message: typeof data.error === "string" ? data.error : res.statusText })); return; }
      if (Array.isArray(data.folders)) setProjects(data.folders.filter(isProjectFolder));
      showStatus(t("files.unpinned", { name: folder.name }), 2500);
      // An unpinned folder may be one the box would suggest again.
      void loadProjects();
    } catch (e) {
      showStatus(t("files.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  // ─── GitHub backup of project folders (TASK-1358) ──────────────────────────

  // Who is signed in: the suggestion card is the OWNER's alone, and a session
  // the box has said is someone else's never asks the owner's routes at all.
  const sessionUser = useSessionUser();
  const mayUseOwnerApis = useMayUseOwnerApis();
  const [backupOverview, setBackupOverview] = useState<BackupOverview | null>(null);
  const [backupFor, setBackupFor] = useState<ProjectFolder | null>(null);
  const [backupHelpOpen, setBackupHelpOpen] = useState(false);
  const [backupClock, setBackupClock] = useState(() => Date.now());

  // Read when the Projects view is on screen (it asks GitHub whether the box
  // is connected, so not on every folder a window opens), and again after the
  // panel changed something.
  const loadBackupOverview = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/project-backup", { cache: "no-store" });
      const data = await res.json().catch(() => null) as Partial<BackupOverview> | null;
      if (!res.ok || !data || !data.github || typeof data.github.connected !== "boolean" || !Array.isArray(data.folders)) return;
      setBackupOverview({
        github: data.github,
        folders: data.folders.filter((f): f is FolderBackupSummary => !!f && typeof f.path === "string" && typeof f.state === "string"),
        suggestionDismissedAt: typeof data.suggestionDismissedAt === "number" ? data.suggestionDismissedAt : null,
      });
      setBackupClock(Date.now());
    } catch { /* no badges and no card — the Projects view itself is unaffected */ }
  }, []);
  useEffect(() => {
    if (place === "projects" && mayUseOwnerApis === true) void loadBackupOverview();
  }, [place, mayUseOwnerApis, loadBackupOverview]);

  const backupSummaries: Record<string, FolderBackupSummary> = {};
  for (const f of backupOverview?.folders ?? []) backupSummaries[f.path] = f;
  const presentProjects = projects.filter((f) => !f.missing);
  const showBackupSuggestion = shouldShowBackupSuggestion({
    isOwner: sessionUser?.isOwner,
    github: backupOverview?.github ?? null,
    folders: (backupOverview?.folders ?? []).filter((f) => presentProjects.some((p) => p.path === f.path)),
    dismissedAt: backupOverview?.suggestionDismissedAt ?? null,
    now: backupClock,
  });

  const dismissBackupSuggestion = () => {
    const at = Date.now();
    setBackupOverview((o) => (o ? { ...o, suggestionDismissedAt: at } : o));
    void fetch("/setup-api/project-backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss_suggestion" }),
    }).catch(() => { /* shown again next time; nothing lost */ });
  };

  /** "Set up backup": the first pinned folder with no online copy, else the first one. */
  const setUpBackup = () => {
    const first = presentProjects.find((p) => backupSummaries[p.path]?.state === "none") ?? presentProjects[0];
    if (first) setBackupFor(first);
  };

  /** The pin for exactly this folder, if it has one. */
  const pinFor = (relPath: string) => projects.find((f) => f.path === relPath) ?? null;
  const togglePin = (relPath: string) => {
    const pin = pinFor(relPath);
    if (pin) void unpinFolder(pin);
    else void pinFolder(relPath);
  };

  // POSIX hidden files start with a dot. We filter client-side because the
  // server returns the full directory; this lets the toggle flip instantly
  // without a re-fetch.
  const visibleFiles = showHidden ? files : files.filter((f) => !f.name.startsWith("."));

  // ─── Search ──────────────────────────────────────────────────────────────────

  const entryRelPath = useCallback(
    (entry: FileEntry) => entry.path ?? (currentPath ? `${currentPath}/${entry.name}` : entry.name),
    [currentPath],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setRecursive(false);
    setSearchResults([]);
    setSearchStoppedBy(null);
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setRecursive(true);
    try {
      const res = await fetch(
        `/setup-api/files?dir=${encodeURIComponent(currentPath)}&search=${encodeURIComponent(term)}&hidden=${showHidden ? "1" : "0"}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      const sorted = [...(data.files as FileEntry[])].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return (a.path ?? a.name).localeCompare(b.path ?? b.name);
      });
      setSearchResults(sorted);
      // An older server answers `truncated` alone; a full match list is what
      // that always meant before the walk learned to say so.
      setSearchStoppedBy(data.stoppedBy ?? (data.truncated ? "matches" : null));
    } catch (e) {
      setSearchResults([]);
      showStatus(e instanceof Error ? e.message : "Search failed", 3000);
    } finally {
      setSearching(false);
    }
  }, [currentPath, showHidden, showStatus]);

  // Re-render whatever is on screen after a mutation (rename/delete/save):
  // re-run the search if results are showing, otherwise reload the folder.
  const refreshView = useCallback(() => {
    if (recursive && query.trim()) runSearch(query);
    else load(currentPath);
  }, [recursive, query, runSearch, load, currentPath]);

  // The same, for the end of a LONG action — an upload, a bulk delete, a move:
  // whatever is on screen when it finishes, not what was on screen when it
  // started, or a folder the owner walked into meanwhile is swapped back out
  // from under them.
  const refreshViewRef = useRef(refreshView);
  useEffect(() => { refreshViewRef.current = refreshView; }, [refreshView]);
  const refreshLatest = useCallback(() => refreshViewRef.current(), []);

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // The list to display: recursive results when present, else a live
  // case-insensitive filter of the current folder, else the full folder.
  const q = query.trim().toLowerCase();
  const displayFiles = recursive
    ? searchResults
    : q
      ? visibleFiles.filter((f) => f.name.toLowerCase().includes(q))
      : visibleFiles;
  const searchActive = recursive || q.length > 0;

  // ─── Selection ──────────────────────────────────────────────────────────────

  // Read off what is SHOWN: an item the filter hides, or one a reload took
  // away, is not acted on however it was selected.
  const displayOrder = displayFiles.map(entryId);
  const selectedEntries = displayFiles.filter((e) => selection.ids.has(entryId(e)));
  const selectedCount = selectedEntries.length;
  const allSelected = displayFiles.length > 0 && selectedCount === displayFiles.length;
  useEffect(() => {
    if (selectMode && selectedCount === 0) setSelectMode(false);
  }, [selectMode, selectedCount]);

  const handleItemClick = (e: React.MouseEvent, entry: FileEntry) => {
    e.stopPropagation();
    setSelection(clickSelection(selection, displayOrder, entryId(entry), {
      range: e.shiftKey,
      toggle: e.ctrlKey || e.metaKey || selectMode,
    }));
  };
  const selectAllShown = () => setSelection(selectAll(displayOrder));
  const toggleSelectAll = () => (allSelected ? clearSelection() : selectAllShown());

  // ─── Other Files windows ────────────────────────────────────────────────────

  const instanceId = useId();
  const announceChange = useCallback(() => {
    window.dispatchEvent(new CustomEvent(FILES_CHANGED_EVENT, { detail: { source: instanceId } }));
  }, [instanceId]);
  // What this window shows, for the listener below without re-subscribing it
  // on every navigation. A window showing search results keeps them: a reload
  // would drop them, and the owner did not ask for that.
  const showsFolderRef = useRef(false);
  useEffect(() => { showsFolderRef.current = place === "folder" && !recursive; }, [place, recursive]);
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ source?: string }>).detail?.source === instanceId) return;
      if (showsFolderRef.current) void load(currentPathRef.current);
    };
    window.addEventListener(FILES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(FILES_CHANGED_EVENT, onChanged);
  }, [instanceId, load]);

  // ─── Breadcrumbs ────────────────────────────────────────────────────────────

  // `path` null is the Projects view. Inside a pinned project the trail is
  // Projects › <project> › …, not Home › .openclaw › workspace › projects › …
  const breadcrumbs: { label: string; path: string | null }[] = (() => {
    if (place === "projects") return [{ label: t("files.projects"), path: null }];
    const segs = currentPath.split("/").filter(Boolean);
    const trail = (from: number, prefix: string[]) => segs.slice(from).map((seg, i) => ({
      label: seg,
      path: [...prefix, ...segs.slice(from, from + i + 1)].join("/"),
    }));
    if (projectRoot) {
      const rootSegs = projectRoot.path.split("/");
      return [
        { label: t("files.projects"), path: null },
        { label: projectRoot.name, path: projectRoot.path },
        ...trail(rootSegs.length, rootSegs),
      ];
    }
    return [{ label: t("files.home"), path: "" }, ...trail(0, [])];
  })();
  // Which crumbs are drawn: all of them, or — in a window too narrow for the
  // trail — the folder itself with its ancestors folded behind one "…".
  const shownCrumbs = narrow && breadcrumbs.length > 2
    ? [breadcrumbs.length - 2, breadcrumbs.length - 1]
    : breadcrumbs.map((_, i) => i);

  // ─── Navigation ────────────────────────────────────────────────────────────

  const openProjects = () => {
    if (recursive || searchOpen) closeSearch();
    setViewer(null);
    setSelection(EMPTY_SELECTION);
    showStatus(null);
    setPlace("projects");
    void loadProjects();
  };

  const openFolder = (dir: string) => {
    if (recursive || searchOpen) closeSearch();
    setPlace("folder");
    void load(dir);
  };

  const navigateBreadcrumb = (idx: number) => {
    const crumb = breadcrumbs[idx];
    if (!crumb) return;
    if (crumb.path === null) openProjects();
    else openFolder(crumb.path);
  };

  // One level up: to the Projects view from a project's own folder, else to
  // the parent folder; nothing above the home folder or the Projects view.
  function goUp() {
    if (place === "projects") return;
    if (projectRoot && currentPath === projectRoot.path) { openProjects(); return; }
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    void load(parts.join("/"));
  }

  // Open: directories navigate (search results jump to their real location);
  // files open in the in-window viewer/editor.
  const navigateTo = (entry: FileEntry) => {
    if (entry.type === "directory") {
      const next = entryRelPath(entry);
      if (recursive) closeSearch();
      load(next);
    } else {
      setViewer({ relPath: entryRelPath(entry), entry });
    }
  };

  // ─── Download ──────────────────────────────────────────────────────────────

  const downloadFile = (entry: FileEntry) => {
    downloadViaLink(filesUrl(entryRelPath(entry)), entry.name);
  };

  // A folder goes down as one ZIP. The box is asked first what it would hold,
  // so "too many files" is said here instead of as a failed download in the
  // browser's list, and the owner sees how big it is before it starts.
  const downloadFolderZip = async (relPath: string, name: string) => {
    const url = `${filesUrl(relPath)}?zip=1`;
    showStatus(t("files.zipPreparing", { name: `${name}.zip` }));
    try {
      const res = await fetch(`${url}&check=1`);
      const data = await res.json().catch(() => ({})) as { code?: unknown; error?: unknown; limit?: unknown; files?: unknown; bytes?: unknown };
      if (!res.ok) {
        showStatus(data.code === "too_many_entries"
          ? t("files.zipTooMany", { max: typeof data.limit === "number" ? data.limit.toLocaleString() : "" })
          : t("files.errorPrefix", { message: typeof data.error === "string" ? data.error : res.statusText }));
        return;
      }
      downloadViaLink(url, `${name}.zip`);
      showStatus(t("files.zipStarted", {
        name: `${name}.zip`,
        count: typeof data.files === "number" ? data.files : 0,
        size: formatSize(typeof data.bytes === "number" ? data.bytes : 0),
      }), 5000);
    } catch (e) {
      showStatus(t("files.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  // A selection of several goes down as ONE ZIP. The list travels in a POST
  // that answers what the archive would hold and a ticket; the download is a
  // plain link that redeems it, so the browser streams it to disk. See
  // src/lib/zip-tickets.ts for why the list is not in the link.
  const downloadSelectionZip = async (entries: FileEntry[]) => {
    const folderName = currentPath ? currentPath.split("/").pop() : "";
    showStatus(t("files.zipPreparing", { name: folderName ? `${folderName}-selection.zip` : "selection.zip" }));
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(currentPath)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "zip", paths: entries.map(entryRelPath) }),
      });
      const data = await res.json().catch(() => ({})) as { code?: unknown; error?: unknown; limit?: unknown; files?: unknown; bytes?: unknown; ticket?: unknown; name?: unknown };
      if (!res.ok || typeof data.ticket !== "string") {
        showStatus(data.code === "too_many_entries"
          ? t("files.zipSelectionTooMany", { max: typeof data.limit === "number" ? data.limit.toLocaleString() : "" })
          : t("files.errorPrefix", { message: typeof data.error === "string" ? data.error : res.statusText }));
        return;
      }
      const name = typeof data.name === "string" ? data.name : "selection.zip";
      downloadViaLink(`/setup-api/files?zip=${encodeURIComponent(data.ticket)}`, name);
      showStatus(t("files.zipStarted", {
        name,
        count: typeof data.files === "number" ? data.files : 0,
        size: formatSize(typeof data.bytes === "number" ? data.bytes : 0),
      }), 5000);
    } catch (e) {
      showStatus(t("files.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  /** Download what is selected: a file as itself, a folder as its ZIP, several as one ZIP. */
  const downloadEntries = (entries: FileEntry[]) => {
    if (entries.length === 0) return;
    if (entries.length > 1) { void downloadSelectionZip(entries); return; }
    const [only] = entries;
    if (only.type === "directory") void downloadFolderZip(entryRelPath(only), only.name);
    else downloadFile(only);
  };

  // ─── Upload ────────────────────────────────────────────────────────────────

  /** The status line's name for a folder: its own name, or Home. */
  const folderLabel = (rel: string) => (rel ? rel.split("/").pop() ?? rel : t("files.home"));

  /**
   * Upload into `destDir` — the folder on screen unless the upload dialog, or
   * a drop onto a folder, chose another one.
   */
  const uploadFiles = async (fileList: FileList | File[] | null, destDir: string = currentPath) => {
    if (!fileList || fileList.length === 0) return;
    const total = fileList.length;
    const totalSize = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);

    // Check available disk space — on the destination's disk.
    try {
      const checkRes = await fetch(`/setup-api/files?dir=${encodeURIComponent(destDir)}`);
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.availableSpace && totalSize > checkData.availableSpace) {
          showStatus(tr("files.noDiskSpace", "Not enough disk space. Need {need}, only {available} available.", {
            need: formatSize(totalSize),
            available: formatSize(checkData.availableSpace),
          }));
          return;
        }
      }
    } catch { /* proceed anyway */ }

    let ok = 0;
    for (let i = 0; i < total; i++) {
      const file = fileList[i];
      showStatus(tr("files.uploadingFile", "Uploading {name} ({index}/{total})…", { name: file.name, index: i + 1, total }));
      try {
        const res = await fetch(
          `/setup-api/files?dir=${encodeURIComponent(destDir)}&name=${encodeURIComponent(file.name)}`,
          { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file }
        );
        if (res.ok) {
          ok++;
        } else {
          const data = await res.json().catch(() => ({}));
          if (data.error) {
            showStatus(data.error);
            refreshLatest();
            return;
          }
        }
      } catch { /* ignore */ }
    }
    showStatus(destDir === currentPath
      ? tr("files.uploadedCount", "Uploaded {ok}/{total} file(s)", { ok, total })
      : t("files.uploadedTo", { ok, total, folder: folderLabel(destDir) }), 2500);
    refreshLatest();
    if (ok > 0) announceChange();
  };

  // ─── Move ──────────────────────────────────────────────────────────────────

  /** Why a move was refused, in the owner's words; the route's own text is the last resort. */
  const moveRefusal = (code: unknown, message: unknown): string => {
    switch (code) {
      case "into_itself": return t("files.moveIntoItself");
      case "protected_container": return t("files.protectedFolder");
      case "cross_device": return t("files.moveCrossDevice");
      case "permission_denied": return t("files.permissionDenied");
      default: return t("files.errorPrefix", { message: typeof message === "string" && message ? message : "?" });
    }
  };

  /**
   * Move `paths` into `dest`. Asked first without a conflict policy: a name
   * the destination already holds comes back as a question (keep both or
   * skip) before anything has moved, and the answer re-sends the move.
   */
  const movePaths = async (paths: string[], dest: string, conflict: "fail" | "rename" | "skip" = "fail") => {
    // The route refuses both too; saying it here is saying it without a trip.
    if (paths.some((p) => isInsideOrSame(dest, p))) { showStatus(t("files.moveIntoItself"), 4000); return; }
    const movable = paths.filter((p) => parentOf(p) !== dest);
    if (movable.length === 0) { showStatus(t("files.moveSameFolder"), 2500); return; }
    showStatus(t("files.moving", { count: movable.length }));
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dest)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", paths: movable, conflict }),
      });
      const data = await res.json().catch(() => ({})) as { code?: unknown; error?: unknown; conflicts?: unknown; moved?: unknown; failed?: unknown };
      if (res.status === 409 && data.code === "conflict" && Array.isArray(data.conflicts)) {
        showStatus(null);
        setMoveConflict({ paths: movable, dest, conflicts: data.conflicts.filter(isMoveConflictItem) });
        return;
      }
      if (!res.ok) { showStatus(moveRefusal(data.code, data.error)); return; }
      const moved = Array.isArray(data.moved) ? data.moved.length : 0;
      const failed = Array.isArray(data.failed) ? data.failed as { code?: unknown; error?: unknown }[] : [];
      clearSelection();
      if (failed.length > 0) {
        showStatus(t("files.moveSomeFailed", {
          moved, total: movable.length, failed: failed.length, message: moveRefusal(failed[0]?.code, failed[0]?.error),
        }));
      } else {
        showStatus(t("files.movedTo", { count: moved, folder: folderLabel(dest) }), 3000);
      }
    } catch (e) {
      showStatus(t("files.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
    }
    refreshLatest();
    announceChange();
    // A moved project folder keeps its pin under its new path.
    void loadProjects();
  };

  // ─── Drag & Drop ──────────────────────────────────────────────────────────

  const dragTypes = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []);
  /** An item being dragged inside the desktop, from this Files window or another. */
  const isItemDrag = (e: React.DragEvent) => dragTypes(e).includes(FILES_DRAG_TYPE);
  /** Files dragged in from the owner's computer. */
  const isUploadDrag = (e: React.DragEvent) => !isItemDrag(e) && dragTypes(e).includes("Files");

  // The whole window keeps its drags to itself. The desktop under it has a
  // drop zone of its own that saves to Downloads: left to bubble, a file let
  // go on a folder here went to BOTH places, and the desktop's "saved to
  // Downloads" overlay covered the window while it was dragged. What no target
  // in the window took (the toolbar, the sidebar's heading) is refused rather
  // than left to the browser, which would open the file in place of the desktop.
  const shieldDrag = (e: React.DragEvent) => {
    if (!isItemDrag(e) && !dragTypes(e).includes("Files")) return;
    e.stopPropagation();
    if ((e.type === "dragover" || e.type === "drop") && !e.defaultPrevented) {
      e.preventDefault();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
    }
  };

  // The folder on screen: files from the computer upload into it. An item
  // dragged around inside it is not a drop here — it is already here.
  const handleDragOver = (e: React.DragEvent) => {
    if (isItemDrag(e)) return;
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (isItemDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  };

  // An item picks up the whole selection when it is part of one, else itself.
  const handleItemDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const id = entryId(entry);
    const dragging = selection.ids.has(id) ? selectedEntries : [entry];
    if (!selection.ids.has(id)) setSelection({ ids: new Set([id]), anchor: id });
    const paths = dragging.map(entryRelPath);
    activeDragPaths = paths;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(FILES_DRAG_TYPE, JSON.stringify(paths));
  };
  const handleItemDragEnd = () => {
    activeDragPaths = null;
    setDropTarget(null);
  };

  /**
   * What makes `dest` a place to drop on — a folder in the listing, a crumb,
   * a sidebar place. Items dragged here MOVE into it (never into themselves,
   * never onto the folder they are already in: those are not drop targets at
   * all); files from the computer UPLOAD into it.
   */
  const folderDropProps = (dest: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (isItemDrag(e)) {
        if (!activeDragPaths || !canMoveInto(activeDragPaths, dest)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      } else if (isUploadDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(false);
      } else {
        return;
      }
      if (dropTarget !== dest) setDropTarget(dest);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropTarget((current) => (current === dest ? null : current));
    },
    onDrop: (e: React.DragEvent) => {
      const item = isItemDrag(e);
      if (!item && !isUploadDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      setDragOver(false);
      if (item) {
        const paths = parseDragPaths(e.dataTransfer.getData(FILES_DRAG_TYPE)) ?? activeDragPaths ?? [];
        activeDragPaths = null;
        if (paths.length > 0) void movePaths(paths, dest);
      } else {
        void uploadFiles(e.dataTransfer.files, dest);
      }
    },
  });

  // ─── Create Folder ────────────────────────────────────────────────────────

  const createFolder = async (name: string) => {
    const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(currentPath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mkdir", name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showStatus(tr("files.errorPrefix", "Error: {message}", { message: data.error ?? res.statusText })); return; }
    showStatus(tr("files.folderCreated", "Folder created"), 2000);
    load(currentPath);
  };

  // ─── Rename ───────────────────────────────────────────────────────────────

  const renameEntry = async (entry: FileEntry, newName: string) => {
    const url = `/setup-api/files/${entryRelPath(entry).split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showStatus(tr("files.errorPrefix", "Error: {message}", { message: data.error ?? res.statusText })); return; }
    showStatus(tr("files.renamed", "Renamed"), 2000);
    refreshView();
  };

  // ─── Delete ───────────────────────────────────────────────────────────────

  const deleteEntry = async (entry: FileEntry) => {
    const url = `/setup-api/files/${entryRelPath(entry).split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showStatus(tr("files.errorPrefix", "Error: {message}", { message: data.error ?? res.statusText })); return; }
    showStatus(tr("files.deleted", "Deleted"), 2000);
    refreshView();
    announceChange();
  };

  /**
   * A multi-selection's delete: one request per item through the same route
   * (and the same guards) a single delete takes, carrying on past a refusal
   * so one protected folder does not keep the rest, and saying how many went.
   */
  const deleteEntries = async (entries: FileEntry[]) => {
    const total = entries.length;
    showStatus(t("files.deletingCount", { count: total }));
    let deleted = 0;
    let firstError: string | null = null;
    for (const entry of entries) {
      try {
        const res = await fetch(filesUrl(entryRelPath(entry)), { method: "DELETE" });
        if (res.ok) { deleted++; continue; }
        const data = await res.json().catch(() => ({})) as { code?: unknown; error?: unknown };
        firstError ??= data.code === "protected_container"
          ? t("files.protectedFolder")
          : typeof data.error === "string" && data.error ? data.error : res.statusText;
      } catch (e) {
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    }
    clearSelection();
    if (deleted < total) {
      showStatus(t("files.deleteSomeFailed", { deleted, total, failed: total - deleted, message: firstError ?? "" }));
    } else {
      showStatus(t("files.deletedCount", { count: deleted }), 2500);
    }
    refreshLatest();
    announceChange();
    // A deleted pinned folder shows as missing in the sidebar.
    if (entries.some((e) => e.type === "directory")) void loadProjects();
  };

  /** Ask before deleting: one item by name, several by count. */
  const askDelete = (entries: FileEntry[]) => {
    if (entries.length === 0) return;
    if (entries.length === 1) setDialog({ type: "delete", entry: entries[0] });
    else setDialog({ type: "delete", entries });
  };

  // ─── Dialog submit ────────────────────────────────────────────────────────

  const handleDialogSubmit = () => {
    if (dialog.type === "mkdir" && dialog.value?.trim()) {
      createFolder(dialog.value.trim());
    } else if (dialog.type === "rename" && dialog.entry && dialog.value?.trim()) {
      // The route refuses a path here; the dialog says so before the trip and
      // stays open, rather than the file leaving the folder on a "Renamed".
      const next = dialog.value.trim();
      if (!isBareName(next)) return;
      renameEntry(dialog.entry, next);
    } else if (dialog.type === "delete" && dialog.entries && dialog.entries.length > 0) {
      void deleteEntries(dialog.entries);
    } else if (dialog.type === "delete" && dialog.entry) {
      deleteEntry(dialog.entry);
    }
    setDialog({ type: null });
  };

  /** "Move to…" for these items: the folder picker opens on the folder they are in. */
  const openMoveDialog = (entries: FileEntry[]) => {
    if (entries.length === 0) return;
    setMoveDialog({ paths: entries.map(entryRelPath), entries });
  };

  // ─── Keyboard ───────────────────────────────────────────────────────────────

  // The listing's shortcuts, while nothing else has the keys: a text field,
  // the open file, a dialog or the item menu each keep their own.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (place !== "folder" || viewer || dialog.type || moveDialog || moveConflict || uploadOpen || contextMenu) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      if (displayFiles.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectAllShown();
    } else if (e.key === "Escape" && selectedCount > 0) {
      e.preventDefault();
      clearSelection();
    } else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && selectedCount > 0) {
      e.preventDefault();
      askDelete(selectedEntries);
    } else if (e.key === "Enter" && selectedCount === 1 && !target?.closest?.("button")) {
      e.preventDefault();
      navigateTo(selectedEntries[0]);
    }
  };

  // ─── Context menu ──────────────────────────────────────────────────────────

  // A right-click inside a multi-selection is about the selection; anywhere
  // else it selects the item it landed on, the way it always did.
  const selectForMenu = (entry: FileEntry) => {
    const id = entryId(entry);
    if (!selection.ids.has(id)) setSelection({ ids: new Set([id]), anchor: id });
  };

  const openContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    selectForMenu(entry);
    // Clamp position so menu doesn't overflow viewport
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setContextMenu({ entry, x, y });
  };

  const handleLongPressStart = (e: React.TouchEvent, entry: FileEntry) => {
    const touch = e.touches[0];
    const x = Math.min(touch.clientX, window.innerWidth - 180);
    const y = Math.min(touch.clientY, window.innerHeight - 200);
    longPressRef.current = {
      entry,
      timer: setTimeout(() => {
        selectForMenu(entry);
        setContextMenu({ entry, x, y });
        longPressRef.current = null;
      }, 500),
    };
  };

  const handleLongPressEnd = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  const closeContextMenu = () => setContextMenu(null);

  // ─── Render ───────────────────────────────────────────────────────────────

  // Below NARROW_WIDTH the sidebar floats over the files instead of taking
  // 200 px of them; it is the only state that needs the backdrop and the z-index.
  const sidebarOverlay = narrow;

  return (
    <div
      ref={rootRef}
      // Focusable, so a click anywhere in the window gives it the keys —
      // Ctrl/⌘+A, Delete and Escape work on the selection.
      tabIndex={-1}
      className="flex h-full overflow-hidden relative bg-[var(--bg-deep)] text-[var(--text-primary)] font-body outline-none"
      data-testid="files-app"
      data-narrow={narrow || undefined}
      onClick={closeContextMenu}
      onKeyDown={handleKeyDown}
      onDragEnter={shieldDrag}
      onDragOver={shieldDrag}
      onDragLeave={shieldDrag}
      onDrop={shieldDrag}
    >

      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <>
          {/* Inside the window, never `fixed`: the desktop behind a narrow
              Files window is not this app's to darken. */}
          {sidebarOverlay && (
            <div
              className="absolute inset-0 z-[5] bg-black/50"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          {/* In flow the sidebar carries no z-index at all. Positioned with
              z-6 it painted above the window's own resize handles, which have
              none — the left edge and bottom-left corner of a Files window
              could not be dragged. */}
          <aside className={`flex flex-col py-4 overflow-y-auto h-full w-[200px] shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] ${sidebarOverlay ? "absolute z-[6]" : ""}`}>
            <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              {t("files.favorites")}
            </div>
            {FAVORITES.map((fav) => {
              const active = place === "folder" && currentPath === fav.path;
              return (
                <button
                  key={fav.path}
                  onClick={() => { openFolder(fav.path); if (sidebarOverlay) setSidebarOpen(false); }}
                  {...folderDropProps(fav.path)}
                  data-drop-target={dropTarget === fav.path || undefined}
                  className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left border-l-2 ${
                    dropTarget === fav.path
                      ? "bg-[var(--coral-bright)]/15 text-[var(--text-primary)] border-[var(--coral-bright)] ring-1 ring-inset ring-[var(--coral-bright)]/60"
                      : active
                        ? "bg-white/[0.08] text-[var(--text-primary)] border-[var(--coral-bright)]"
                        : "text-[var(--text-secondary)] border-transparent hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Icon name={fav.icon} size={18} color={active ? "var(--coral-bright)" : "var(--text-muted)"} />
                  <span>{t(fav.labelKey)}</span>
                </button>
              );
            })}

            {/* ── Projects: the folders the owner pinned ── */}
            <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-2" data-testid="files-sidebar-projects">
              <button
                onClick={() => { openProjects(); if (sidebarOverlay) setSidebarOpen(false); }}
                className={`text-[10px] font-semibold uppercase tracking-widest transition-colors cursor-pointer hover:text-[var(--text-primary)] ${
                  place === "projects" ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)]"
                }`}
                aria-current={place === "projects" ? "page" : undefined}
                data-testid="files-projects-nav"
              >
                {t("files.projects")}
              </button>
              <button
                onClick={() => { openProjects(); if (sidebarOverlay) setSidebarOpen(false); }}
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
                title={t("files.projectsAdd")}
                aria-label={t("files.projectsAdd")}
              >
                <Icon name="add" size={14} />
              </button>
            </div>
            {projects.map((folder) => {
              const active = place === "folder" && projectRoot?.path === folder.path;
              return (
                <button
                  key={folder.path}
                  onClick={() => {
                    if (folder.missing) { openProjects(); } else { openFolder(folder.path); }
                    if (sidebarOverlay) setSidebarOpen(false);
                  }}
                  {...(folder.missing ? {} : folderDropProps(folder.path))}
                  data-drop-target={dropTarget === folder.path || undefined}
                  title={folder.missing ? t("files.projectMissing") : `~/${folder.path}`}
                  className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left border-l-2 ${
                    dropTarget === folder.path
                      ? "bg-[var(--coral-bright)]/15 text-[var(--text-primary)] border-[var(--coral-bright)] ring-1 ring-inset ring-[var(--coral-bright)]/60"
                      : active
                        ? "bg-white/[0.08] text-[var(--text-primary)] border-[var(--coral-bright)]"
                        : "text-[var(--text-secondary)] border-transparent hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                  } ${folder.missing ? "opacity-50" : ""}`}
                  data-testid="files-sidebar-project"
                >
                  <Icon
                    name={folder.missing ? "error" : "folder_special"}
                    size={18}
                    color={active ? "var(--coral-bright)" : "var(--text-muted)"}
                  />
                  <span className="truncate min-w-0">{folder.name}</span>
                </button>
              );
            })}
            {projects.length === 0 && projectsState !== "loading" && (
              <button
                onClick={() => { openProjects(); if (sidebarOverlay) setSidebarOpen(false); }}
                className="flex items-center gap-2.5 px-4 py-2 text-xs text-left border-l-2 border-transparent text-[var(--text-muted)] hover:bg-white/[0.04] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <Icon name="push_pin" size={16} color="var(--text-muted)" />
                <span>{t("files.projectsAdd")}</span>
              </button>
            )}

            <div className="mt-auto px-4 pt-4">
              <button
                onClick={() => { setUploadOpen(true); if (sidebarOverlay) setSidebarOpen(false); }}
                disabled={place === "projects"}
                data-testid="files-upload"
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] border border-[var(--coral-bright)]/30 hover:bg-[var(--coral-bright)]/25 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                <Icon name="upload" size={16} />
                {t("files.upload")}
              </button>
            </div>
          </aside>
        </>
      )}

      {/* ── Main area ── */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {(sidebarOverlay || !sidebarOpen) && (
            <button
              onClick={() => setSidebarOpen(p => !p)}
              className="p-1.5 rounded-md transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={t("files.favorites")}
              aria-label={t("files.favorites")}
              data-testid="files-sidebar-toggle"
            >
              <Icon name="menu" size={18} />
            </button>
          )}
          <button
            onClick={goUp}
            disabled={place === "projects" || !currentPath}
            className="p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-default text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06]"
            title={t("files.goUp")}
          >
            <Icon name="chevron_left" size={18} />
          </button>

          {/* Breadcrumb. A trail that does not fit is clipped from the RIGHT,
              so the crumb that goes first is the folder the owner is IN. The
              ancestors give way instead: they shrink, and in a narrow window
              they fold into one "…" that still walks up a level. */}
          <div className="flex items-center gap-1 flex-1 min-w-0 text-sm overflow-hidden" data-testid="files-breadcrumbs">
            {shownCrumbs.map((idx, pos) => {
              const isLast = idx === breadcrumbs.length - 1;
              const folded = pos === 0 && idx > 0;
              // Every folder crumb is a drop target, so an item goes UP by
              // being dragged onto the folder it should be in.
              const crumbPath = breadcrumbs[idx].path;
              const crumbDrop = crumbPath !== null && place === "folder";
              return (
                <span key={idx} className={`flex items-center gap-1 ${isLast ? "shrink-0" : "min-w-0 shrink"}`}>
                  {pos > 0 && <Icon name="chevron_right" size={14} color="var(--text-muted)" />}
                  <button
                    onClick={() => navigateBreadcrumb(idx)}
                    {...(crumbDrop ? folderDropProps(crumbPath) : {})}
                    data-drop-target={(crumbDrop && dropTarget === crumbPath) || undefined}
                    title={breadcrumbs[idx].label}
                    className={`hover:underline truncate cursor-pointer rounded px-0.5 ${isLast ? "max-w-[180px]" : "max-w-[120px]"} ${
                      isLast ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"
                    } ${crumbDrop && dropTarget === crumbPath ? "bg-[var(--coral-bright)]/20 ring-1 ring-[var(--coral-bright)]/60" : ""}`}
                  >
                    {folded ? "…" : breadcrumbs[idx].label}
                  </button>
                </span>
              );
            })}
          </div>

          {/* Actions — the folder's own; the Projects view lists no folder, so
              it keeps Refresh alone. */}
          {place === "projects" ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => { showStatus(null); void loadProjects(); }}
                className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
                title={t("files.refresh")}
              >
                <Icon name="refresh" size={18} />
              </button>
            </div>
          ) : (
          <div className="flex items-center gap-1 shrink-0">
            {projectRoot && !error && (
              <button
                onClick={() => setBackupFor(projectRoot)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] cursor-pointer"
                title={t("files.backup.buttonTitle", { name: projectRoot.name })}
                aria-label={t("files.backup.buttonTitle", { name: projectRoot.name })}
                data-testid="files-backup-toolbar"
              >
                <Icon name="cloud_upload" size={16} />
                {!narrow && <span>{t("files.backup.button")}</span>}
              </button>
            )}
            {currentPath && !error && (() => {
              const pinned = !!pinFor(currentPath);
              const label = pinned ? t("files.unpinFolder") : t("files.pinFolder");
              return (
                <button
                  onClick={() => togglePin(currentPath)}
                  className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer ${
                    pinned ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                  title={label}
                  aria-label={label}
                  aria-pressed={pinned}
                  data-testid="files-pin-toggle"
                >
                  <Icon name={pinned ? "keep_off" : "push_pin"} size={18} />
                </button>
              );
            })()}
            <button
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer ${
                searchOpen || searchActive
                  ? "text-[var(--coral-bright)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title={t("files.search")}
              aria-pressed={searchOpen}
            >
              <Icon name="search" size={18} />
            </button>
            <button
              onClick={() => setDialog({ type: "mkdir", value: "" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] cursor-pointer"
              title={t("files.newFolder")}
            >
              <Icon name="create_new_folder" size={16} />
              {!narrow && <span>{t("files.newFolder")}</span>}
            </button>
            <button
              onClick={() => { showStatus(null); load(currentPath); }}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={t("files.refresh")}
            >
              <Icon name="refresh" size={18} />
            </button>
            <button
              onClick={toggleSelectAll}
              disabled={loading || !!error || displayFiles.length === 0}
              className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer disabled:opacity-25 disabled:cursor-default ${
                allSelected ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title={allSelected ? t("files.clearSelection") : t("files.selectAll")}
              aria-label={allSelected ? t("files.clearSelection") : t("files.selectAll")}
              aria-pressed={allSelected}
              data-testid="files-select-all"
            >
              <Icon name={allSelected ? "deselect" : "select_all"} size={18} />
            </button>
            <button
              onClick={toggleShowHidden}
              className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer ${
                showHidden
                  ? "text-[var(--coral-bright)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title={showHidden ? t("files.hideHiddenFiles") : t("files.showHiddenFiles")}
              aria-pressed={showHidden}
            >
              <Icon name={showHidden ? "visibility" : "visibility_off"} size={18} />
            </button>
            <button
              onClick={() => setViewMode(v => v === "grid" ? "list" : "grid")}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={viewMode === "grid" ? t("files.switchToList") : t("files.switchToGrid")}
            >
              <Icon name={viewMode === "grid" ? "view_list" : "grid_view"} size={18} />
            </button>
          </div>
          )}
        </div>

        {/* ── Selection bar: what a multi-selection can do. One clicked item is
            a selection too, but it is not a reason to change the toolbar —
            its menu has everything the bar would. ── */}
        {place === "folder" && (selectedCount > 1 || (selectMode && selectedCount > 0)) && (
          <SelectionBar
            count={selectedCount}
            total={displayFiles.length}
            narrow={narrow}
            onDownload={() => downloadEntries(selectedEntries)}
            onMove={() => openMoveDialog(selectedEntries)}
            onDelete={() => askDelete(selectedEntries)}
            onClear={() => { clearSelection(); setSelectMode(false); }}
          />
        )}

        {/* ── Search bar ── */}
        {searchOpen && (
          <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <Icon name="search" size={16} className="text-[var(--text-muted)] shrink-0" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setRecursive(false); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (query.trim()) runSearch(query); }
                else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
              }}
              placeholder={t("files.searchPlaceholder")}
              className="flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-muted)]"
            />
            {query.trim() && !recursive && (
              <button
                onClick={() => runSearch(query)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs whitespace-nowrap transition-colors bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer shrink-0"
                title={t("files.searchEverywhere")}
              >
                <Icon name="travel_explore" size={14} />
                <span className="hidden sm:inline">{t("files.searchEverywhere")}</span>
              </button>
            )}
            {searching && <Icon name="progress_activity" size={16} className="motion-safe:animate-spin text-[var(--text-muted)] shrink-0" />}
            <button
              onClick={closeSearch}
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer shrink-0"
              title={t("files.clearSearch")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}

        {/* ── File Area ── */}
        {place === "projects" ? (
          <div className="flex-1 overflow-y-auto relative">
            <ProjectsView
              folders={projects}
              suggestions={suggestions}
              state={projectsState}
              narrow={narrow}
              onOpen={(folder) => openFolder(folder.path)}
              onDownload={(folder) => void downloadFolderZip(folder.path, folder.name)}
              onRemove={(folder) => void unpinFolder(folder)}
              onAdd={pinFolder}
              onRetry={() => void loadProjects()}
              backup={backupSummaries}
              backupClock={backupClock}
              onBackup={(folder) => setBackupFor(folder)}
              suggestion={showBackupSuggestion ? (
                <BackupSuggestionCard
                  onSetUp={setUpBackup}
                  onDismiss={dismissBackupSuggestion}
                  onLearnMore={() => setBackupHelpOpen(true)}
                />
              ) : null}
            />
          </div>
        ) : (
        <div
          ref={dropZoneRef}
          className={`flex-1 overflow-y-auto relative transition-colors ${dragOver ? "bg-[var(--coral-bright)]/5" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && dropTarget === null && (
            <div className="absolute inset-2 z-20 flex items-center justify-center pointer-events-none rounded-xl border-2 border-dashed border-[var(--coral-bright)]/50">
              <div className="text-center text-[var(--coral-bright)]">
                <Icon name="upload_file" size={48} className="mb-2" />
                <div className="text-sm font-medium">{t("files.dropToUpload")}</div>
              </div>
            </div>
          )}

          {recursive && !searching && displayFiles.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-xs backdrop-blur bg-[var(--bg-surface)]/90 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
              <Icon name="search" size={13} />
              <span className="truncate">{t("files.searchResultsFor", { query: query.trim() })}</span>
              <span className="opacity-70 shrink-0">· {displayFiles.length}</span>
              {searchStoppedBy === "matches" && (
                <span className="opacity-70 shrink-0">· {t("files.searchTruncated", { count: displayFiles.length })}</span>
              )}
              {/* Not "first N shown": every match found IS shown — the walk
                  ran out of budget, so part of the tree was never searched. */}
              {searchStoppedBy === "scanned" && (
                <span className="opacity-70 shrink-0" data-testid="files-search-stopped">
                  · {tr("files.searchStoppedEarly", "stopped early — some folders were not searched")}
                </span>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              <Icon name="progress_activity" size={24} className="motion-safe:animate-spin mr-2" />
              {t("files.loading")}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full flex-col gap-2 text-red-400">
              <Icon name="error" size={40} />
              <span className="text-sm">{error}</span>
              <button onClick={() => load(currentPath)} className="text-xs underline mt-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">{t("files.retry")}</button>
            </div>
          ) : displayFiles.length === 0 ? (
            searchActive ? (
              <div className="flex items-center justify-center h-full flex-col gap-2 text-[var(--text-muted)]">
                <Icon name="search_off" size={56} color="var(--border-subtle)" />
                <span className="text-sm">
                  {searching ? t("files.searching") : t("files.searchNoResults", { query: query.trim() })}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full flex-col gap-2 text-[var(--text-muted)]">
                <Icon name="folder_open" size={56} color="var(--border-subtle)" />
                <span className="text-sm">
                  {files.length === 0 ? t("files.emptyFolder") : t("files.hiddenAllItems")}
                </span>
                <span className="text-xs">
                  {files.length === 0 ? t("files.dropOrUpload") : t("files.hiddenToggleEye")}
                </span>
              </div>
            )
          ) : (() => {
            const itemProps: ItemViewProps = {
              files: displayFiles,
              showLocation: recursive,
              selectedIds: selection.ids,
              checkmarks: selectMode || selectedCount > 1,
              onItemClick: handleItemClick,
              onBackgroundClick: clearSelection,
              onOpen: navigateTo,
              onContextMenu: openContextMenu,
              onLongPressStart: handleLongPressStart,
              onLongPressEnd: handleLongPressEnd,
              onItemDragStart: handleItemDragStart,
              onItemDragEnd: handleItemDragEnd,
              folderDropProps: (entry) => folderDropProps(entryRelPath(entry)),
              isDropTarget: (entry) => dropTarget === entryRelPath(entry),
            };
            return viewMode === "grid" ? <GridView {...itemProps} /> : <ListView {...itemProps} narrow={narrow} />;
          })()}
        </div>
        )}

        {/* ── Status bar ── */}
        <div className="px-4 py-1.5 text-xs flex items-center justify-between shrink-0 border-t border-[var(--border-subtle)] text-[var(--text-muted)]">
          <span data-testid="files-status" className="min-w-0 truncate">
            {statusMsg ?? (place === "projects"
              ? t("files.projectsCount", { count: projects.length })
              : searchActive
                ? tr("files.results", "{count} result(s)", { count: displayFiles.length })
                : t("files.items", { count: visibleFiles.length }))}
            {/* The count of hidden entries belongs to the COUNT, not to
                "Folder created · 22 hidden". */}
            {place === "folder" && !statusMsg && !searchActive && !showHidden && files.length > visibleFiles.length && (
              <span className="opacity-60"> · {tr("files.hiddenCount", "{count} hidden", { count: files.length - visibleFiles.length })}</span>
            )}
            {place === "folder" && !statusMsg && selectedCount > 0 && (
              <span data-testid="files-status-selected"> · {t("files.selectedCount", { count: selectedCount })}</span>
            )}
          </span>
          {place === "folder" && currentPath && <span className="opacity-60 truncate min-w-0 ml-3">~/{currentPath}</span>}
        </div>
      </div>

      {/* ── Context Menu ── */}
      {contextMenu && (() => {
        // Right-clicked inside a multi-selection: the menu is the selection's.
        const multi = selectedCount > 1 && selection.ids.has(entryId(contextMenu.entry));
        const targets = multi ? selectedEntries : [contextMenu.entry];
        return (
          <ContextMenu
            entry={contextMenu.entry}
            selectionCount={multi ? selectedCount : 1}
            x={contextMenu.x}
            y={contextMenu.y}
            onOpen={() => { closeContextMenu(); navigateTo(contextMenu.entry); }}
            onDownload={() => { closeContextMenu(); downloadEntries(targets); }}
            pinned={contextMenu.entry.type === "directory" && !!pinFor(entryRelPath(contextMenu.entry))}
            onTogglePin={() => { closeContextMenu(); togglePin(entryRelPath(contextMenu.entry)); }}
            onRename={() => { closeContextMenu(); setDialog({ type: "rename", entry: contextMenu.entry, value: contextMenu.entry.name }); }}
            onMove={() => { closeContextMenu(); openMoveDialog(targets); }}
            onSelect={selectMode || multi ? undefined : () => {
              closeContextMenu();
              const id = entryId(contextMenu.entry);
              setSelection({ ids: new Set([id]), anchor: id });
              setSelectMode(true);
            }}
            onDelete={() => { closeContextMenu(); askDelete(targets); }}
            onClose={closeContextMenu}
          />
        );
      })()}

      {/* ── File viewer / editor ── */}
      {viewer && (
        <FileViewer
          relPath={viewer.relPath}
          entry={viewer.entry}
          onClose={() => setViewer(null)}
          onSaved={refreshView}
        />
      )}

      {/* ── Dialogs ── */}
      {dialog.type && (
        <DialogOverlay
          dialog={dialog}
          onChange={(value) => setDialog(d => ({ ...d, value }))}
          onCancel={() => setDialog({ type: null })}
          onSubmit={handleDialogSubmit}
        />
      )}

      {moveDialog && (
        <FolderPickerDialog
          testId="files-move-dialog"
          icon="drive_file_move"
          title={moveDialog.entries.length === 1
            ? t("files.moveTitleOne", { name: moveDialog.entries[0].name })
            : t("files.moveTitleMany", { count: moveDialog.entries.length })}
          confirmLabel={t("files.moveHere")}
          // Opens where the items are, so the owner starts one step from anywhere.
          initialDir={parentOf(moveDialog.paths[0])}
          projects={projects}
          showHidden={showHidden}
          movingPaths={moveDialog.paths}
          canConfirm={(dir) => canMoveInto(moveDialog.paths, dir)}
          onCancel={() => setMoveDialog(null)}
          onConfirm={(dir) => {
            const { paths } = moveDialog;
            setMoveDialog(null);
            void movePaths(paths, dir);
          }}
        />
      )}

      {moveConflict && (
        <MoveConflictDialog
          conflict={moveConflict}
          folderName={folderLabel(moveConflict.dest)}
          onCancel={() => setMoveConflict(null)}
          onResolve={(policy) => {
            const { paths, dest } = moveConflict;
            setMoveConflict(null);
            void movePaths(paths, dest, policy);
          }}
        />
      )}

      {backupFor && (
        <ProjectBackupPanel
          folder={backupFor}
          onClose={() => setBackupFor(null)}
          onChanged={() => void loadBackupOverview()}
        />
      )}

      {backupHelpOpen && <GitHubHelpDialog onClose={() => setBackupHelpOpen(false)} />}

      {uploadOpen && (
        <UploadDialog
          initialDir={currentPath}
          projects={projects}
          showHidden={showHidden}
          onCancel={() => setUploadOpen(false)}
          onUpload={(chosen, dir) => {
            setUploadOpen(false);
            void uploadFiles(chosen, dir);
          }}
        />
      )}
    </div>
  );
}

// ─── Projects View ────────────────────────────────────────────────────────────

// The owner's pinned folders, what this box already keeps projects in, and a
// path box for anything else. Every folder opens as an ordinary Files folder;
// this view only decides which ones are a click away.
function ProjectsView({
  folders, suggestions, state, narrow, onOpen, onDownload, onRemove, onAdd, onRetry,
  backup = {}, backupClock = 0, onBackup, suggestion = null,
}: {
  folders: ProjectFolder[];
  suggestions: ProjectFolder[];
  state: "loading" | "ready" | "error";
  narrow: boolean;
  onOpen: (folder: ProjectFolder) => void;
  onDownload: (folder: ProjectFolder) => void;
  onRemove: (folder: ProjectFolder) => void;
  /** Pin by path; answers the refusal it showed, or null once it landed. */
  onAdd: (path: string) => Promise<string | null>;
  onRetry: () => void;
  /** Each pinned folder's GitHub backup state, by path (TASK-1358). */
  backup?: Record<string, FolderBackupSummary>;
  /** The clock the "Backed up 2 hours ago" lines are measured against. */
  backupClock?: number;
  onBackup?: (folder: ProjectFolder) => void;
  /** The "keep a safe copy on GitHub" card, when it should show. */
  suggestion?: React.ReactNode;
}) {
  const { t, locale } = useT();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // The folder (or typed path) a pin is on its way for, so a second click
  // does not send a second one.
  const [busy, setBusy] = useState<string | null>(null);

  const add = async (value: string, fromForm: boolean) => {
    const target = value.trim();
    if (!target || busy) return;
    setBusy(target);
    const refusal = await onAdd(target);
    setBusy(null);
    if (fromForm) {
      setAddError(refusal);
      if (!refusal) setTyped("");
    }
  };

  const action = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-default";
  const sectionLabel = "flex items-center gap-1.5 mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]";

  return (
    <div className="p-4 flex flex-col gap-6 max-w-3xl" data-testid="files-projects">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-[var(--coral-bright)]/15">
          <Icon name="folder_special" size={24} color="var(--coral-bright)" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("files.projects")}</h2>
          <p className="text-xs mt-0.5 leading-relaxed text-[var(--text-muted)]">{t("files.projectsIntro")}</p>
        </div>
      </div>

      {suggestion}

      {folders.length === 0 ? (
        state === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Icon name="progress_activity" size={18} className="motion-safe:animate-spin" />
            {t("files.loading")}
          </div>
        ) : state === "error" ? (
          <div className="flex items-center gap-3 text-sm text-red-400" data-testid="files-projects-error">
            <Icon name="error" size={18} />
            <span>{t("files.projectsLoadError")}</span>
            <button onClick={onRetry} className="text-xs underline text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">{t("files.retry")}</button>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-6 text-center" data-testid="files-projects-empty">
            <Icon name="push_pin" size={32} color="var(--border-subtle)" />
            <div className="mt-2 text-sm text-[var(--text-secondary)]">{t("files.projectsEmpty")}</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">{t("files.projectsEmptyHint")}</div>
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-2" data-testid="files-projects-list">
          {folders.map((folder) => (
            <li
              key={folder.path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] ${folder.missing ? "opacity-60" : ""}`}
              data-testid="files-project-row"
            >
              <button
                onClick={() => { if (!folder.missing) onOpen(folder); }}
                disabled={folder.missing}
                title={`~/${folder.path}`}
                className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default"
              >
                <Icon name={folder.missing ? "error" : "folder_special"} size={28} color={folder.missing ? "#f87171" : "#f97316"} />
                <span className="flex flex-col min-w-0">
                  <span className="truncate text-sm font-medium text-[var(--text-primary)]">{folder.name}</span>
                  <span className="truncate text-[11px] text-[var(--text-muted)]">
                    {folder.missing ? t("files.projectMissing") : `~/${folder.path}`}
                  </span>
                  {!folder.missing && (() => {
                    const line = backupRowText(backup[folder.path], t, locale, backupClock);
                    if (!line) return null;
                    const state = backup[folder.path]?.state;
                    return (
                      <span
                        className={`truncate text-[11px] flex items-center gap-1 ${state === "backed_up" ? "text-emerald-400/90" : "text-[var(--text-muted)]"}`}
                        data-testid="files-project-backup-state"
                      >
                        <Icon name={state === "backed_up" ? "cloud_done" : state === "existing_git" ? "account_tree" : "cloud_off"} size={12} />
                        {line}
                      </span>
                    );
                  })()}
                </span>
              </button>
              <div className="flex items-center gap-1.5 shrink-0">
                {!folder.missing && (
                  <>
                    <button onClick={() => onOpen(folder)} className={action} title={t("files.open")} aria-label={t("files.open")}>
                      <Icon name="folder_open" size={15} />
                      {!narrow && <span>{t("files.open")}</span>}
                    </button>
                    <button
                      onClick={() => onDownload(folder)}
                      className={action}
                      title={`${t("files.downloadZip")} — ${t("files.zipLeftOut")}`}
                      aria-label={t("files.downloadZip")}
                    >
                      <Icon name="folder_zip" size={15} />
                      {!narrow && <span>{t("files.downloadZip")}</span>}
                    </button>
                    {onBackup && (
                      <button
                        onClick={() => onBackup(folder)}
                        className={action}
                        title={t("files.backup.buttonTitle", { name: folder.name })}
                        aria-label={t("files.backup.buttonTitle", { name: folder.name })}
                        data-testid="files-project-backup"
                      >
                        <Icon name="cloud_upload" size={15} />
                        {!narrow && <span>{t("files.backup.button")}</span>}
                      </button>
                    )}
                  </>
                )}
                <button
                  onClick={() => onRemove(folder)}
                  className={action}
                  title={t("files.unpinFolder")}
                  aria-label={t("files.unpinFolder")}
                >
                  <Icon name="keep_off" size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <section data-testid="files-projects-suggestions">
          <h3 className={sectionLabel}>
            <Icon name="lightbulb" size={13} />
            {t("files.projectsSuggested")}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {suggestions.map((s) => (
              <li key={s.path} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <Icon name="folder" size={22} color="var(--text-secondary)" />
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-sm text-[var(--text-secondary)]">{s.name}</span>
                  <span className="truncate text-[11px] text-[var(--text-muted)]">~/{s.path}</span>
                </span>
                <button
                  onClick={() => void add(s.path, false)}
                  disabled={busy !== null}
                  className={action}
                  aria-label={`${t("files.pinFolder")}: ${s.name}`}
                >
                  <Icon name="add" size={15} />
                  <span>{t("files.projectsAddButton")}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); void add(typed, true); }}
        className="flex flex-col gap-2"
        data-testid="files-projects-add"
      >
        <label htmlFor={inputId} className={sectionLabel}>
          <Icon name="create_new_folder" size={13} />
          {t("files.projectsAddPath")}
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            value={typed}
            onChange={(e) => { setTyped(e.target.value); setAddError(null); }}
            placeholder={t("files.projectsPathPlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={addError ? true : undefined}
            className={`flex-1 min-w-0 px-3 py-2 bg-[var(--bg-deep)] border rounded-lg text-sm text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-[var(--text-muted)] ${
              addError ? "border-red-500" : "border-[var(--border-subtle)]"
            }`}
          />
          <button
            type="submit"
            disabled={!typed.trim() || busy !== null}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white btn-gradient hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {t("files.projectsAddButton")}
          </button>
        </div>
        {addError ? (
          <p className="text-xs text-red-400" data-testid="files-projects-add-error">{addError}</p>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">{t("files.projectsPathHint")}</p>
        )}
      </form>
    </div>
  );
}

// ─── Grid View ────────────────────────────────────────────────────────────────

/** What both views take: the listing, the selection, and every gesture on an item. */
interface ItemViewProps {
  files: FileEntry[];
  showLocation?: boolean;
  selectedIds: ReadonlySet<string>;
  /** Draw a tick on each selected item — while more than one is, or in select mode. */
  checkmarks: boolean;
  onItemClick: (e: React.MouseEvent, entry: FileEntry) => void;
  onBackgroundClick: () => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onLongPressStart: (e: React.TouchEvent, entry: FileEntry) => void;
  onLongPressEnd: () => void;
  onItemDragStart: (e: React.DragEvent, entry: FileEntry) => void;
  onItemDragEnd: () => void;
  /** The drop handlers that make a FOLDER item a place to move into. */
  folderDropProps: (entry: FileEntry) => Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">;
  isDropTarget: (entry: FileEntry) => boolean;
}

/** The props every item carries, whichever view draws it. */
function itemProps(p: ItemViewProps, entry: FileEntry, id: string, selected: boolean) {
  return {
    role: "option" as const,
    "aria-selected": selected,
    "data-testid": "files-entry",
    "data-name": entry.name,
    "data-selected": selected || undefined,
    draggable: true,
    onClick: (e: React.MouseEvent) => p.onItemClick(e, entry),
    onDoubleClick: () => p.onOpen(entry),
    onContextMenu: (e: React.MouseEvent) => p.onContextMenu(e, entry),
    onTouchStart: (e: React.TouchEvent) => p.onLongPressStart(e, entry),
    onTouchEnd: p.onLongPressEnd,
    onTouchMove: p.onLongPressEnd,
    onDragStart: (e: React.DragEvent) => p.onItemDragStart(e, entry),
    onDragEnd: p.onItemDragEnd,
    ...(entry.type === "directory" ? p.folderDropProps(entry) : {}),
    key: id,
  };
}

function SelectedTick() {
  return (
    <span className="absolute top-1 left-1 flex items-center justify-center w-4 h-4 rounded-full bg-[var(--coral-bright)] text-white pointer-events-none" aria-hidden="true">
      <Icon name="check" size={12} />
    </span>
  );
}

function GridView(p: ItemViewProps) {
  return (
    <div className="p-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}
      data-testid="files-grid"
      role="listbox"
      aria-multiselectable="true"
      onClick={p.onBackgroundClick}>
      {p.files.map((entry) => {
        const id = entryId(entry);
        const isSelected = p.selectedIds.has(id);
        const dropHere = p.isDropTarget(entry);
        const fi = fileIcon(entry.name, entry.type);
        const { key, ...rest } = itemProps(p, entry, id, isSelected);
        return (
          <div
            key={key}
            {...rest}
            title={p.showLocation && entry.path ? entry.path : entry.name}
            data-drop-target={dropHere || undefined}
            className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl cursor-pointer transition-all select-none ${
              dropHere
                ? "bg-[var(--coral-bright)]/20 border border-[var(--coral-bright)] ring-2 ring-[var(--coral-bright)]/40"
                : isSelected
                  ? "bg-[var(--coral-bright)]/10 border border-[var(--coral-bright)]/40"
                  : "border border-transparent hover:bg-white/[0.04]"
            }`}
          >
            {isSelected && p.checkmarks && <SelectedTick />}
            <Icon name={dropHere ? "folder_open" : fi.icon} size={36} color={fi.color} />
            <span className="text-xs text-center line-clamp-2 w-full leading-tight text-[var(--text-primary)]" style={{ wordBreak: "break-word" }}>
              {entry.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function ListView({ narrow, ...p }: ItemViewProps & {
  /** The window, not the screen: see NARROW_WIDTH. */
  narrow?: boolean;
}) {
  const { t } = useT();
  // 80 px of size and 160 px of date are fixed, so in a 300 px-wide window
  // they left the name one letter. The date is the column that goes: it is the
  // widest and the least of the three, and it is still in the tooltip.
  const columns = narrow ? "1fr 80px" : "1fr 80px 160px";
  return (
    <div className="w-full" data-testid="files-list" data-narrow={narrow || undefined} role="listbox" aria-multiselectable="true" onClick={p.onBackgroundClick}>
      {/* Header */}
      <div className="grid px-4 py-2 text-xs font-medium sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-deep)] text-[var(--text-muted)]"
        style={{ gridTemplateColumns: columns }}>
        <span>{t("files.name")}</span>
        <span className="text-right">{t("files.size")}</span>
        {!narrow && <span className="text-right">{t("files.modified")}</span>}
      </div>
      {p.files.map((entry) => {
        const id = entryId(entry);
        const isSelected = p.selectedIds.has(id);
        const dropHere = p.isDropTarget(entry);
        const fi = fileIcon(entry.name, entry.type);
        const location = parentDirOf(entry.path);
        const { key, ...rest } = itemProps(p, entry, id, isSelected);
        return (
          <div
            key={key}
            {...rest}
            data-drop-target={dropHere || undefined}
            className={`grid px-4 py-2 items-center cursor-pointer transition-colors border-b border-white/[0.03] select-none ${
              dropHere
                ? "bg-[var(--coral-bright)]/20 outline outline-1 outline-[var(--coral-bright)]"
                : isSelected ? "bg-[var(--coral-bright)]/10" : "hover:bg-white/[0.03]"
            }`}
            style={{ gridTemplateColumns: columns }}
            title={formatDate(entry.modified)}
          >
            <span className="flex items-center gap-2.5 min-w-0">
              {p.checkmarks && (
                <Icon
                  name={isSelected ? "check_box" : "check_box_outline_blank"}
                  size={16}
                  color={isSelected ? "var(--coral-bright)" : "var(--text-muted)"}
                />
              )}
              <Icon name={dropHere ? "folder_open" : fi.icon} size={20} color={fi.color} />
              <span className="flex flex-col min-w-0">
                <span className="truncate text-sm text-[var(--text-primary)]">{entry.name}</span>
                {p.showLocation && (
                  <span className="truncate text-[11px] text-[var(--text-muted)] leading-tight">
                    {location ? `~/${location}` : t("files.home")}
                  </span>
                )}
              </span>
            </span>
            <span className="text-right text-xs text-[var(--text-muted)]">{formatSize(entry.size)}</span>
            {!narrow && <span className="text-right text-xs text-[var(--text-muted)]">{formatDate(entry.modified)}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Context Menu ────────────────────────────────────────────────────────────

function ContextMenu({ entry, selectionCount = 1, x, y, onOpen, onDownload, pinned, onTogglePin, onRename, onMove, onSelect, onDelete, onClose }: {
  entry: FileEntry;
  /** More than one: the menu was opened on a multi-selection and acts on all of it. */
  selectionCount?: number;
  x: number;
  y: number;
  onOpen: () => void;
  /** A file downloads as itself, a folder as one ZIP, a selection as one ZIP. */
  onDownload: () => void;
  /** Folders only: whether it is pinned to Projects, and the toggle. */
  pinned?: boolean;
  onTogglePin?: () => void;
  onRename: () => void;
  onMove: () => void;
  /** Start a selection here (touch has no Ctrl key); absent once one is under way. */
  onSelect?: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    el.focus();
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`;
    }
  }, [x, y]);

  const { t } = useT();
  const tr = useTr();
  const items: { icon: string; label: string; onClick: () => void; danger?: boolean; color?: string }[] = [];
  const multi = selectionCount > 1;

  if (multi) {
    items.push({ icon: "folder_zip", label: t("files.downloadSelection", { count: selectionCount }), onClick: onDownload });
    items.push({ icon: "drive_file_move", label: t("files.moveTo"), onClick: onMove });
  } else {
    if (entry.type === "directory") {
      items.push({ icon: "folder_open", label: t("files.open"), onClick: onOpen });
      items.push({ icon: "folder_zip", label: t("files.downloadZip"), onClick: onDownload });
      if (onTogglePin) {
        items.push(pinned
          ? { icon: "keep_off", label: t("files.unpinFolder"), onClick: onTogglePin }
          : { icon: "push_pin", label: t("files.pinFolder"), onClick: onTogglePin });
      }
    } else {
      items.push({ icon: "open_in_new", label: t("files.open"), onClick: onOpen });
      items.push({ icon: "download", label: t("files.download"), onClick: onDownload });
    }
    items.push({ icon: "edit", label: t("files.rename"), onClick: onRename });
    items.push({ icon: "drive_file_move", label: t("files.moveTo"), onClick: onMove });
    if (onSelect) items.push({ icon: "check_box", label: t("files.select"), onClick: onSelect });
  }
  items.push({ icon: "delete", label: t("files.delete"), onClick: onDelete, danger: true });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % items.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        items[focusedIndex].onClick();
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={tr("files.actionsFor", "Actions for {name}", { name: entry.name })}
      tabIndex={-1}
      className="fixed z-50 min-w-[160px] py-1.5 rounded-xl shadow-2xl border border-[var(--border-subtle)] overflow-hidden outline-none"
      style={{ left: x, top: y, background: "var(--bg-elevated)", backdropFilter: "blur(16px)" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {/* File info header — or the selection's count */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-2">
        {multi ? (
          <>
            <Icon name="select_all" size={16} color="var(--coral-bright)" />
            <span className="text-xs text-[var(--text-secondary)] truncate max-w-[160px]">{t("files.selectedCount", { count: selectionCount })}</span>
          </>
        ) : (
          <>
            <Icon name={fileIcon(entry.name, entry.type).icon} size={16} color={fileIcon(entry.name, entry.type).color} />
            <span className="text-xs text-[var(--text-secondary)] truncate max-w-[120px]">{entry.name}</span>
          </>
        )}
      </div>
      {items.map((item, i) => (
        <button
          key={item.label}
          role="menuitem"
          tabIndex={i === focusedIndex ? 0 : -1}
          onClick={item.onClick}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left cursor-pointer ${
            i === focusedIndex ? "bg-white/[0.08]" : ""
          } ${
            item.danger
              ? "text-red-400 hover:bg-red-500/10"
              : "text-[var(--text-primary)] hover:bg-white/[0.06]"
          }`}
        >
          <Icon name={item.icon} size={18} color={item.danger ? "#f87171" : item.color ?? "var(--text-muted)"} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ─── Dialog Overlay ───────────────────────────────────────────────────────────

function DialogOverlay({ dialog, onChange, onCancel, onSubmit }: {
  dialog: DialogState;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useT();
  const tr = useTr();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dialog.type !== "delete") inputRef.current?.select(); }, [dialog.type]);

  const isDelete = dialog.type === "delete";
  const many = dialog.entries?.length ?? 0;
  const title = dialog.type === "mkdir" ? t("files.newFolderTitle")
    : dialog.type === "rename" ? t("files.renameTitle")
    : many > 0 ? t("files.deleteManyTitle", { count: many })
    : tr("files.deleteTitle", "Delete “{name}”?", { name: dialog.entry?.name ?? "" });
  // "All contents will be deleted" belongs to a delete that takes a folder.
  const takesFolder = many > 0 ? dialog.entries!.some((e) => e.type === "directory") : dialog.entry?.type === "directory";

  // A rename is a name. `../escape.txt` used to be accepted here and the route
  // moved the file to the parent folder under a "Renamed" — the owner's only
  // sign was the file gone from the folder they were looking at.
  const typed = (dialog.value ?? "").trim();
  const pathTyped = dialog.type === "rename" && typed.length > 0 && !isBareName(typed);
  const submit = () => { if (!pathTyped) onSubmit(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}>
      <div
        className="card-surface rounded-2xl p-6 w-80 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-4 text-[var(--text-primary)] flex items-center gap-2">
          <Icon
            name={isDelete ? "delete" : dialog.type === "mkdir" ? "create_new_folder" : "edit"}
            size={20}
            color={isDelete ? "#ef4444" : "var(--coral-bright)"}
          />
          {title}
        </h3>
        {isDelete ? (
          <div className="mb-5" data-testid="files-delete-body">
            {many > 0 && (
              <ul className="mb-3 max-h-28 overflow-y-auto text-xs text-[var(--text-muted)] flex flex-col gap-0.5">
                {dialog.entries!.slice(0, 8).map((e) => (
                  <li key={e.path ?? e.name} className="flex items-center gap-1.5 min-w-0">
                    <Icon name={fileIcon(e.name, e.type).icon} size={14} color={fileIcon(e.name, e.type).color} />
                    <span className="truncate">{e.name}</span>
                  </li>
                ))}
                {many > 8 && <li className="pl-5">…</li>}
              </ul>
            )}
            <p className="text-sm text-[var(--text-secondary)]">
              {tr("files.cannotUndo", "This action cannot be undone.")} {takesFolder ? t("files.deleteConfirm") : ""}
            </p>
          </div>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={dialog.value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
            className={`w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500 ${pathTyped ? "border-red-500 mb-2" : "border-gray-600 mb-5"}`}
            placeholder={dialog.type === "mkdir" ? t("files.folderName") : t("files.newName")}
            aria-invalid={pathTyped || undefined}
          />
        )}
        {pathTyped && (
          <p className="text-xs mb-5 text-red-400" data-testid="files-rename-invalid">
            {tr("files.nameNotPath", "Enter a name, not a path.")}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
          >
            {t("cancel")}
          </button>
          <button
            onClick={submit}
            disabled={pathTyped}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer text-white disabled:opacity-40 disabled:cursor-default ${
              isDelete
                ? "bg-red-600 hover:bg-red-500"
                : "btn-gradient hover:opacity-90"
            }`}
          >
            {isDelete ? t("files.delete") : t("files.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Selection Bar ────────────────────────────────────────────────────────────

// What a multi-selection can do, above the listing while there is one.
function SelectionBar({ count, total, narrow, onDownload, onMove, onDelete, onClear }: {
  count: number;
  total: number;
  narrow: boolean;
  onDownload: () => void;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const action = "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors cursor-pointer";
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--coral-bright)]/[0.06]"
      data-testid="files-selection-bar"
      role="toolbar"
      aria-label={t("files.selectedCount", { count })}
    >
      <Icon name="select_all" size={16} color="var(--coral-bright)" />
      <span className="text-xs font-medium text-[var(--text-primary)] truncate min-w-0" data-testid="files-selection-count">
        {t("files.selectedOf", { count, total })}
      </span>
      <div className="flex-1" />
      <button
        onClick={onDownload}
        className={`${action} text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.08]`}
        title={t("files.downloadSelection", { count })}
        aria-label={t("files.downloadSelection", { count })}
        data-testid="files-selection-download"
      >
        <Icon name="download" size={15} />
        {!narrow && <span>{t("files.download")}</span>}
      </button>
      <button
        onClick={onMove}
        className={`${action} text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.08]`}
        title={t("files.moveTo")}
        aria-label={t("files.moveTo")}
        data-testid="files-selection-move"
      >
        <Icon name="drive_file_move" size={15} />
        {!narrow && <span>{t("files.moveTo")}</span>}
      </button>
      <button
        onClick={onDelete}
        className={`${action} text-red-400 hover:bg-red-500/10`}
        title={t("files.deleteManyTitle", { count })}
        aria-label={t("files.deleteManyTitle", { count })}
        data-testid="files-selection-delete"
      >
        <Icon name="delete" size={15} />
        {!narrow && <span>{t("files.delete")}</span>}
      </button>
      <button
        onClick={onClear}
        className="p-1 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.08] cursor-pointer"
        title={t("files.clearSelection")}
        aria-label={t("files.clearSelection")}
        data-testid="files-selection-clear"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

// ─── Folder Picker ────────────────────────────────────────────────────────────

/**
 * Choose a folder: where a selection moves to ("Move to…"), where an upload
 * lands. It browses the same Files API the window does — the favourites and
 * the owner's pinned Projects one click away, a trail to walk back up, and a
 * new folder made on the spot — and never offers a folder that is itself
 * being moved.
 */
function FolderPickerDialog({
  testId, icon, title, sectionLabel, confirmLabel, initialDir, projects, showHidden,
  movingPaths = [], canConfirm, confirmDisabled, onCancel, onConfirm, children,
}: {
  testId: string;
  icon: string;
  title: string;
  /** A heading over the folder list, when the dialog holds more than the picker. */
  sectionLabel?: string;
  confirmLabel: string;
  initialDir: string;
  projects: ProjectFolder[];
  showHidden: boolean;
  /** Items being moved: never a place to go into. */
  movingPaths?: string[];
  /** Whether the folder on screen is an answer at all (a move into where the items already are is not). */
  canConfirm?: (dir: string) => boolean;
  /** Something besides the folder holds the confirm back (an upload with no files chosen). */
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: (dir: string) => void;
  children?: React.ReactNode;
}) {
  const { t } = useT();
  const [dir, setDir] = useState(initialDir);
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // Only the newest listing lands: a quick click through two folders must not
  // leave the first one's answer on screen under the second one's name.
  const requestRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const open = useCallback(async (next: string) => {
    const request = ++requestRef.current;
    setDir(next);
    setState("loading");
    setCreating(false);
    setCreateError(null);
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(next)}`);
      const data = await res.json().catch(() => ({})) as { files?: unknown };
      if (request !== requestRef.current) return;
      if (!res.ok || !Array.isArray(data.files)) throw new Error(String(res.status));
      setFolders((data.files as FileEntry[])
        .filter((f) => f.type === "directory" && (showHidden || !f.name.startsWith(".")))
        .sort((a, b) => a.name.localeCompare(b.name)));
      setState("ready");
    } catch {
      if (request !== requestRef.current) return;
      setFolders([]);
      setState("error");
    }
  }, [showHidden]);

  useEffect(() => { void open(initialDir); }, [open, initialDir]);
  useEffect(() => { rootRef.current?.focus(); }, []);

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    if (!isBareName(name)) { setCreateError(t("files.nameNotPath")); return; }
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name }),
      });
      const data = await res.json().catch(() => ({})) as { error?: unknown };
      if (!res.ok) {
        setCreateError(t("files.errorPrefix", { message: typeof data.error === "string" ? data.error : res.statusText }));
        return;
      }
      setNewName("");
      void open(dir ? `${dir}/${name}` : name);
    } catch (e) {
      setCreateError(t("files.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const segs = dir.split("/").filter(Boolean);
  const places = [
    ...FAVORITES.map((f) => ({ key: `fav:${f.path}`, label: t(f.labelKey), icon: f.icon, path: f.path })),
    ...projects.filter((p) => !p.missing).map((p) => ({ key: `project:${p.path}`, label: p.name, icon: "folder_special", path: p.path })),
  ];
  const blocked = (rel: string) => movingPaths.some((p) => isInsideOrSame(rel, p));
  const ready = state === "ready" && !blocked(dir) && (canConfirm ? canConfirm(dir) : true);
  const chip = "flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer shrink-0 max-w-[140px]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="card-surface rounded-2xl p-5 shadow-2xl flex flex-col gap-3 outline-none w-[min(440px,calc(100vw-2rem))] max-h-[min(580px,calc(100vh-2rem))]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
      >
        <h3 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2 min-w-0">
          <Icon name={icon} size={20} color="var(--coral-bright)" />
          <span className="truncate">{title}</span>
        </h3>

        {children}

        {sectionLabel && (
          <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{sectionLabel}</div>
        )}

        {/* Places: the favourites and the pinned projects. */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 shrink-0" data-testid="files-picker-places">
          {places.map((p) => {
            const here = p.path === dir;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => void open(p.path)}
                disabled={blocked(p.path)}
                title={p.path ? `~/${p.path}` : t("files.home")}
                className={`${chip} disabled:opacity-40 disabled:cursor-default ${
                  here
                    ? "bg-[var(--coral-bright)]/15 text-[var(--coral-bright)]"
                    : "bg-white/[0.05] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon name={p.icon} size={14} />
                <span className="truncate">{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Where the picker is: up a level, and the trail. */}
        <div className="flex items-center gap-1 min-w-0 text-sm shrink-0">
          <button
            type="button"
            onClick={() => void open(parentOf(dir))}
            disabled={!dir}
            title={t("files.goUp")}
            aria-label={t("files.goUp")}
            className="p-1 rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-default text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06]"
          >
            <Icon name="arrow_upward" size={16} />
          </button>
          <div className="flex items-center gap-0.5 min-w-0 overflow-hidden" data-testid="files-picker-trail">
            <button type="button" onClick={() => void open("")} className="truncate hover:underline cursor-pointer text-[var(--text-muted)] shrink-0">
              {t("files.home")}
            </button>
            {segs.map((seg, i) => (
              <span key={i} className={`flex items-center gap-0.5 ${i === segs.length - 1 ? "shrink-0" : "min-w-0 shrink"}`}>
                <Icon name="chevron_right" size={13} color="var(--text-muted)" />
                <button
                  type="button"
                  onClick={() => void open(segs.slice(0, i + 1).join("/"))}
                  title={seg}
                  className={`truncate hover:underline cursor-pointer max-w-[140px] ${i === segs.length - 1 ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"}`}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* The folders in it. */}
        <div className="flex-1 min-h-[140px] overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]" data-testid="files-picker-list">
          {state === "loading" ? (
            <div className="flex items-center justify-center h-full min-h-[140px] text-sm text-[var(--text-muted)]">
              <Icon name="progress_activity" size={18} className="motion-safe:animate-spin mr-2" />
              {t("files.loading")}
            </div>
          ) : state === "error" ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[140px] gap-2 text-sm text-red-400">
              <Icon name="error" size={22} />
              <button type="button" onClick={() => void open(dir)} className="text-xs underline text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">
                {t("files.retry")}
              </button>
            </div>
          ) : folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[140px] gap-1 text-sm text-[var(--text-muted)]">
              <Icon name="folder_open" size={28} color="var(--border-subtle)" />
              {t("files.pickerNoFolders")}
            </div>
          ) : (
            <ul className="py-1">
              {folders.map((f) => {
                const rel = dir ? `${dir}/${f.name}` : f.name;
                const isBlocked = blocked(rel);
                return (
                  <li key={f.name}>
                    <button
                      type="button"
                      onClick={() => void open(rel)}
                      disabled={isBlocked}
                      title={isBlocked ? t("files.pickerBeingMoved") : `~/${rel}`}
                      data-testid="files-picker-folder"
                      data-name={f.name}
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors cursor-pointer text-[var(--text-primary)] hover:bg-white/[0.05] disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <Icon name="folder" size={18} color="#f59e0b" />
                      <span className="truncate flex-1 min-w-0">{f.name}</span>
                      {!isBlocked && <Icon name="chevron_right" size={16} color="var(--text-muted)" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* A new folder, made where the picker is. */}
        {creating ? (
          <div className="flex flex-col gap-1 shrink-0">
            <div className="flex gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void createFolder(); }
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCreating(false); }
                }}
                placeholder={t("files.folderName")}
                aria-invalid={createError ? true : undefined}
                data-testid="files-picker-new-name"
                className={`flex-1 min-w-0 px-3 py-1.5 bg-[var(--bg-deep)] border rounded-lg text-sm text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] placeholder-[var(--text-muted)] ${createError ? "border-red-500" : "border-[var(--border-subtle)]"}`}
              />
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={!newName.trim()}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white btn-gradient hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                {t("files.ok")}
              </button>
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={state !== "ready" || blocked(dir)}
            data-testid="files-picker-new-folder"
            className="self-start flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors cursor-pointer bg-white/[0.05] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-default shrink-0"
          >
            <Icon name="create_new_folder" size={14} />
            {t("files.newFolder")}
          </button>
        )}

        <div className="flex items-center gap-2 pt-1 shrink-0">
          <span className="flex-1 min-w-0 truncate text-xs text-[var(--text-muted)]" data-testid="files-picker-destination" title={dir ? `~/${dir}` : t("files.home")}>
            {dir ? `~/${dir}` : t("files.home")}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(dir)}
            disabled={!ready || confirmDisabled}
            data-testid={`${testId}-confirm`}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white btn-gradient hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Upload Dialog ────────────────────────────────────────────────────────────

// The files first, then where they go — the folder on screen unless the owner
// picks another one.
function UploadDialog({ initialDir, projects, showHidden, onCancel, onUpload }: {
  initialDir: string;
  projects: ProjectFolder[];
  showHidden: boolean;
  onCancel: () => void;
  onUpload: (files: File[], dir: string) => void;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File[]>([]);
  const totalSize = chosen.reduce((sum, f) => sum + f.size, 0);
  return (
    <FolderPickerDialog
      testId="files-upload-dialog"
      icon="upload"
      title={t("files.uploadTitle")}
      sectionLabel={t("files.uploadTo")}
      confirmLabel={t("files.upload")}
      initialDir={initialDir}
      projects={projects}
      showHidden={showHidden}
      confirmDisabled={chosen.length === 0}
      onCancel={onCancel}
      onConfirm={(dir) => onUpload(chosen, dir)}
    >
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-[var(--border-subtle)] p-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            data-testid="files-upload-choose"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 shrink-0"
          >
            <Icon name="attach_file" size={16} />
            {t("files.chooseFiles")}
          </button>
          <span className="text-xs text-[var(--text-muted)] truncate min-w-0" data-testid="files-upload-chosen">
            {chosen.length > 0 ? t("files.chosenFiles", { count: chosen.length, size: formatSize(totalSize) }) : t("files.noFilesChosen")}
          </span>
        </div>
        {chosen.length > 0 && (
          <ul className="max-h-20 overflow-y-auto text-xs text-[var(--text-secondary)] flex flex-col gap-0.5">
            {chosen.slice(0, 6).map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 min-w-0">
                <Icon name={fileIcon(f.name, "file").icon} size={14} color={fileIcon(f.name, "file").color} />
                <span className="truncate">{f.name}</span>
              </li>
            ))}
            {chosen.length > 6 && <li className="pl-5 text-[var(--text-muted)]">…</li>}
          </ul>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="files-upload-input"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length > 0) setChosen(picked);
            e.target.value = "";
          }}
        />
      </div>
    </FolderPickerDialog>
  );
}

// ─── Move Conflict ────────────────────────────────────────────────────────────

// The destination already holds some of the names: keep both (the moved copy
// takes a number) or skip those. Asked before anything has moved.
function MoveConflictDialog({ conflict, folderName, onCancel, onResolve }: {
  conflict: MoveConflict;
  folderName: string;
  onCancel: () => void;
  onResolve: (policy: "rename" | "skip") => void;
}) {
  const { t } = useT();
  const n = conflict.conflicts.length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t("files.conflictTitle", { folder: folderName })}
        data-testid="files-conflict-dialog"
        className="card-surface rounded-2xl p-6 w-[min(360px,calc(100vw-2rem))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
      >
        <h3 className="text-base font-semibold mb-3 text-[var(--text-primary)] flex items-center gap-2 min-w-0">
          <Icon name="warning" size={20} color="#f59e0b" />
          <span className="truncate">{t("files.conflictTitle", { folder: folderName })}</span>
        </h3>
        <p className="text-sm text-[var(--text-secondary)]">
          {n === 1 ? t("files.conflictOne", { name: conflict.conflicts[0].name }) : t("files.conflictMany", { count: n })}
        </p>
        {n > 1 && (
          <ul className="mt-2 max-h-24 overflow-y-auto text-xs text-[var(--text-muted)] flex flex-col gap-0.5">
            {conflict.conflicts.slice(0, 8).map((c) => <li key={c.path} className="truncate">{c.name}</li>)}
            {n > 8 && <li>…</li>}
          </ul>
        )}
        <p className="text-xs mt-3 mb-5 text-[var(--text-muted)]">{t("files.keepBothHint")}</p>
        <div className="flex gap-2 justify-end flex-wrap">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onResolve("skip")}
            data-testid="files-conflict-skip"
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.1] text-[var(--text-primary)] hover:bg-white/[0.15] cursor-pointer"
          >
            {t("files.skipExisting")}
          </button>
          <button
            autoFocus
            onClick={() => onResolve("rename")}
            data-testid="files-conflict-keep-both"
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white btn-gradient hover:opacity-90 cursor-pointer"
          >
            {t("files.keepBoth")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── File Viewer / Editor ───────────────────────────────────────────────────────

// Fills the Files window (absolute inset-0, not a full-screen fixed overlay) so
// it stays inside the window frame. Text/code is editable and saved back via the
// streaming PUT; images/pdf/audio/video preview inline; anything binary or too
// large to edit falls back to a download prompt.
function FileViewer({ relPath, entry, onClose, onSaved }: {
  relPath: string;
  entry: FileEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const initialKind = resolveViewerKind(entry.name, entry.size);
  const [kind, setKind] = useState<ViewerKind>(initialKind);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(initialKind === "text");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const url = `/setup-api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
  const dirty = kind === "text" && content !== original;

  // Fetch text content; a binary sniff downgrades to the non-editable view.
  useEffect(() => {
    if (initialKind !== "text") return;
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        if (looksBinary(text)) {
          setKind("binary");
        } else {
          setContent(text);
          setOriginal(text);
        }
      })
      .catch(() => { if (!cancelled) setError(t("files.loadError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Non-text kinds have no autofocusing textarea — focus the container so the
  // Escape-to-close shortcut works.
  useEffect(() => {
    if (initialKind !== "text") rootRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const slash = relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : relPath.slice(0, slash);
    const fname = slash === -1 ? relPath : relPath.slice(slash + 1);
    try {
      const res = await fetch(
        `/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(fname)}`,
        { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: content },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t("files.saveError"));
      }
      setOriginal(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("files.saveError"));
    } finally {
      setSaving(false);
    }
  }, [content, relPath, onSaved, t]);

  const attemptClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [dirty, onClose]);

  // Phone Back closes the file the same way the X does; with the discard
  // prompt up, it dismisses the prompt first.
  const phoneLayout = usePhoneLayout();
  useMobileBack(phoneLayout, () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else attemptClose();
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the discard confirmation is up, keep keys scoped to it — Escape
    // dismisses it, and nothing else leaks through to the editor underneath.
    if (confirmDiscard) {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmDiscard(false);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty) save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      attemptClose();
    }
  };

  const fi = fileIcon(entry.name, entry.type);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex flex-col bg-[var(--bg-deep)] outline-none"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <Icon name={fi.icon} size={18} color={fi.color} />
        <span className="text-sm font-medium truncate flex-1 text-[var(--text-primary)]" title={relPath}>{entry.name}</span>
        {kind === "text" && (dirty
          ? <span className="text-[11px] text-[var(--text-muted)]" title={t("files.unsavedChanges")}>●</span>
          : saved ? <span className="text-[11px] text-green-400">{t("files.saved")}</span> : null)}
        {kind === "text" && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-default bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer"
            title={t("files.save")}
          >
            <Icon name={saving ? "progress_activity" : "save"} size={16} className={saving ? "motion-safe:animate-spin" : ""} />
            <span className="hidden sm:inline">{t("files.save")}</span>
          </button>
        )}
        <button
          onClick={() => downloadViaLink(url, entry.name)}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
          title={t("files.download")}
        >
          <Icon name="download" size={18} />
        </button>
        <button
          onClick={attemptClose}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
          title={t("files.close")}
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto relative">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
            <Icon name="progress_activity" size={24} className="motion-safe:animate-spin mr-2" />{t("files.loading")}
          </div>
        ) : error ? (
          <ViewerMessage icon="error" text={error} url={url} name={entry.name} color="#f87171" />
        ) : kind === "text" ? (
          <CodeEditor
            value={content}
            onChange={setContent}
            language={languageForFile(entry.name)}
            onSave={() => { if (dirty) void save(); }}
            autoFocus
            ariaLabel={entry.name}
            className="[--cb-code-ground:var(--bg-deep)]"
            testId="files-editor"
          />
        ) : kind === "image" ? (
          <div className="flex items-center justify-center h-full p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={entry.name} className="max-w-full max-h-full object-contain" />
          </div>
        ) : kind === "pdf" ? (
          <iframe src={url} title={entry.name} className="w-full h-full border-0 bg-white" />
        ) : kind === "video" ? (
          <div className="flex items-center justify-center h-full p-4 bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={url} controls className="max-w-full max-h-full" />
          </div>
        ) : kind === "audio" ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
            <Icon name="music_note" size={64} color="#06b6d4" />
            <span className="text-sm text-[var(--text-secondary)] truncate max-w-full">{entry.name}</span>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={url} controls />
          </div>
        ) : kind === "toobig" ? (
          <ViewerMessage icon="visibility_off" text={t("files.fileTooLarge")} url={url} name={entry.name} />
        ) : (
          <ViewerMessage icon="draft" text={t("files.binaryFile")} url={url} name={entry.name} />
        )}
      </div>

      {/* Discard-changes confirmation */}
      {confirmDiscard && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="card-surface rounded-2xl p-6 w-72 shadow-2xl">
            <h3 className="text-base font-semibold mb-4 text-[var(--text-primary)] flex items-center gap-2">
              <Icon name="warning" size={20} color="#f59e0b" />
              {t("files.unsavedChanges")}
            </h3>
            <div className="flex gap-2 justify-end">
              <button
                autoFocus
                onClick={() => setConfirmDiscard(false)}
                className="px-4 py-2 rounded-lg text-sm bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
              >
                {t("cancel")}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 cursor-pointer"
              >
                {t("files.discard")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Fallback panel for files that can't be shown inline (binary, too large, or a
// fetch error): explain why and offer a download.
function ViewerMessage({ icon, text, url, name, color }: {
  icon: string;
  text: string;
  url: string;
  name: string;
  color?: string;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-[var(--text-muted)]">
      <Icon name={icon} size={48} color={color ?? "var(--border-subtle)"} />
      <span className="text-sm max-w-sm">{text}</span>
      <button
        onClick={() => downloadViaLink(url, name)}
        className="flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-lg text-sm bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer"
      >
        <Icon name="download" size={16} />{t("files.downloadInstead")}
      </button>
    </div>
  );
}
