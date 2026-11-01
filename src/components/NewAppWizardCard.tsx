"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "@/lib/i18n";
import { taskTitle } from "@/lib/task-title";
import { renderText } from "@/lib/chat-markdown";
import { mediaUrl } from "@/lib/chat-media";
import { CHAT_ATTACHMENT_MAX_BYTES, createPreviewUrl, revokePreviews } from "@/lib/chat-attachments";
import {
  continueList,
  imageToken,
  indentLines,
  insertBlock,
  insertText,
  planChecks,
  planScore,
  PLAN_SECTIONS,
  renumberImageTokens,
  toggleLineStyle,
  wrapSelection,
  type EditResult,
  type LineStyle,
  type PlanChecks,
  type PlanSection,
} from "@/lib/plan-editor";
import {
  buildNewAppPrompt,
  buildResumeProjectPrompt,
  buildTeamProjectPrompt,
  DEFAULT_NEW_APP_TEMPLATE,
  NEW_APP_TEMPLATES,
  dispatchChatMessage,
  type NewAppTemplate,
} from "@/lib/ui-events";

/**
 * The Create PLANNER — what "Create app" opens, wherever it is pressed: the
 * chat composer's `+`, the desktop's `+` tile, the Coding Agent's buttons, the
 * assistant's `ui_open_card`.
 *
 * Redesigned on 2026-11-01 at the owner's ask ("make it like a planner, an
 * advanced text editor … bullets, paste images rendered as small thumbs …
 * for easy create / edit of complex tasks"). It used to be a five-field card
 * over the chat composer; it is now a window of its own (PopoutWindow, drawn
 * by CodingChatCards' NewAppCardSlot) holding:
 *
 * - ONE brief, written in Markdown in an editor with a toolbar — heading,
 *   bold, italic, bulleted / numbered / check lists, quote, code — lists that
 *   continue on Enter and end on an empty item, Tab / Shift+Tab to indent,
 *   Ctrl+B / Ctrl+I, and a Preview drawn by the chat's own renderer;
 * - planning SECTIONS the toolbar inserts (Goal, Features, Screens and
 *   layout, Data, Done when, Constraints) and a PLAN CHECK beside the brief
 *   that says what a strong brief still lacks — a nudge, never a gate;
 * - PICTURES: pasted, dropped or picked, staged on the box through the chat's
 *   own staging route, drawn as small thumbnails and referred to in the brief
 *   as `[image 1]`; the composed message names their paths and tells the
 *   assistant how a run gets them (`referencesLines` in ui-events);
 * - the switches — Run as a coding team, Ultracode, and Show me the plan
 *   first — and the starter for a new app;
 * - a DRAFT kept in this browser as the owner types, so a long plan survives
 *   a closed window, a refresh or a stray Escape; Create clears it.
 *
 * It still composes ONE message and hands it to the mascot chat through
 * `dispatchChatMessage`: the run is the assistant's to start, with the tools
 * it has, and the owner watches it happen in the chat. Two modes, as before:
 * a NEW app, or an EXISTING project with what its next run should do.
 */

/** Where the planner remembers the owner's last choice of each switch (per browser). */
const TOGGLE_STORAGE = {
  team: "clawbox:create-card:team",
  ultracode: "clawbox:create-card:ultracode",
  planFirst: "clawbox:create-card:plan-first",
} as const;
type ToggleName = keyof typeof TOGGLE_STORAGE;

/** The remembered choice, or off: a private window, blocked storage or a throwing accessor all read as off. */
function rememberedToggle(which: ToggleName): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem(TOGGLE_STORAGE[which]) === "1";
  } catch {
    return false;
  }
}

function rememberToggle(which: ToggleName, on: boolean): void {
  try {
    window.localStorage?.setItem(TOGGLE_STORAGE[which], on ? "1" : "0");
  } catch {
    // localStorage unavailable: the choice holds for this window and no longer.
  }
}

/** Where the draft lives (per browser). Versioned: a later shape reads an older one as nothing. */
export const PLANNER_DRAFT_KEY = "clawbox:create-planner:draft:v1";

interface PlannerImage {
  /** Local key for the strip; never sent. */
  key: string;
  name: string;
  /** The staged copy's absolute path — empty while it is uploading. */
  path: string;
  /** A local object URL, while this page holds the bytes. */
  previewUrl?: string;
  uploading?: boolean;
}

interface PlannerDraft {
  mode: WizardMode;
  name: string;
  brief: string;
  template: NewAppTemplate;
  projectDir: string;
  images: { name: string; path: string }[];
}

function readDraft(): PlannerDraft | null {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage?.getItem(PLANNER_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PlannerDraft> | null;
    if (!d || typeof d !== "object") return null;
    return {
      mode: d.mode === "existing" ? "existing" : "new",
      name: typeof d.name === "string" ? d.name : "",
      brief: typeof d.brief === "string" ? d.brief : "",
      template: NEW_APP_TEMPLATES.includes(d.template as NewAppTemplate) ? (d.template as NewAppTemplate) : DEFAULT_NEW_APP_TEMPLATE,
      projectDir: typeof d.projectDir === "string" ? d.projectDir : "",
      images: Array.isArray(d.images)
        ? d.images.filter((i): i is { name: string; path: string } => !!i && typeof i.name === "string" && typeof i.path === "string" && !!i.path)
        : [],
    };
  } catch {
    return null;
  }
}

function writeDraft(draft: PlannerDraft | null): void {
  try {
    if (!draft) window.localStorage?.removeItem(PLANNER_DRAFT_KEY);
    else window.localStorage?.setItem(PLANNER_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // No storage: the plan lives as long as the window does.
  }
}

/** Nothing worth keeping: no name, no brief, no pictures. */
function draftIsEmpty(d: Pick<PlannerDraft, "name" | "brief" | "images">): boolean {
  return !d.name.trim() && !d.brief.trim() && d.images.length === 0;
}

/**
 * The longest name the planner accepts — the same bound as
 * assertProjectName in src/lib/code-projects.ts (MAX_PROJECT_NAME_LENGTH),
 * which is what refuses the name once the assistant scaffolds the project.
 * Checked here so the owner hears it before the handoff, not from a tool
 * error in the chat. Exported so a test can pin the two together; a client
 * component cannot import the library constant, which pulls in fs.
 */
export const NEW_APP_NAME_MAX = 60;

/**
 * The brief ceiling when the caller has no live status to read it from — the
 * run route's own default for `maxTaskChars`. The route refuses anything
 * longer anyway; this only lets the planner say so first.
 */
export const DEFAULT_MAX_TASK_CHARS = 4_000;

/** Pictures one plan may carry. */
export const PLANNER_MAX_IMAGES = 12;

/** The select's option label per starter — the order and default live in ui-events. */
const NEW_APP_TEMPLATE_LABEL: Record<NewAppTemplate, string> = {
  nextjs: "codingAgent.newTemplateNextjs",
  react: "codingAgent.newTemplateReact",
  app: "codingAgent.newTemplateApp",
  blank: "codingAgent.newTemplateBlank",
};

/** Each section's heading key; the heading is inserted in the owner's language. */
const SECTION_KEY: Record<PlanSection, string> = {
  goal: "codingAgent.planner.sectionGoal",
  features: "codingAgent.planner.sectionFeatures",
  screens: "codingAgent.planner.sectionScreens",
  data: "codingAgent.planner.sectionData",
  done: "codingAgent.planner.sectionDone",
  constraints: "codingAgent.planner.sectionConstraints",
};

/** What a section starts with under its heading: a list for the list-shaped ones, a checklist for "done when". */
const SECTION_START: Record<PlanSection, string> = {
  goal: "",
  features: "- ",
  screens: "- ",
  data: "- ",
  done: "- [ ] ",
  constraints: "- ",
};

/** English words a "done when" heading may start with, beside the owner's own language. */
const DONE_HEADINGS_EN = ["done when", "acceptance", "definition of done", "success"];

const FIELD =
  "w-full rounded-lg bg-black/25 border border-white/[0.10] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 outline-none transition-colors focus:border-[var(--coral-bright)]/60 focus:ring-1 focus:ring-[var(--coral-bright)]/25";

const LABEL = "block text-xs font-medium text-[var(--text-secondary)]";

const SIDE_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]";

/** A native select clips its option at the edge with nothing to say so; an ellipsis at least reads as a cut. */
const SELECT = "overflow-hidden text-ellipsis whitespace-nowrap";

/** The rendered brief in Preview — the same Markdown look as the run's whole-goal window. */
const PREVIEW =
  "text-[13px] text-[var(--text-secondary)] leading-relaxed break-words [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-3 [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-2 [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_pre]:my-2 [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_a]:decoration-white/30";

/**
 * The first line of the last run's task, for the "Last run:" note.
 *
 * Cut with an ellipsis rather than in silence: the hard 120-character slice
 * ended "…and quote the", which reads as a rendering fault rather than as a
 * summary. Exported for its test.
 */
export function lastRunSummary(task: string, max = 120): string {
  const line = taskTitle(task, Number.MAX_SAFE_INTEGER);
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/**
 * What the "Last run:" line says about a run.
 *
 * An automatic review pass has no task of its own — its `task` IS the
 * REVIEW_PASS_TASK prompt the runner hands the model — so its first line read
 * "Automatic review pass. Start by running the project's own verification —
 * its tests or build — in THIS pass and quote the" here while the sidebar,
 * the run's page and the breadcrumb all called it "Automatic review pass of
 * run-xyz". Same rule as theirs, from the same key.
 */
export function lastRunLabel(
  run: { task: string; reviewOf?: string | null },
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : lastRunSummary(run.task);
}

/** One row of GET /setup-api/coding-agent/projects, as the planner reads it. */
interface ProjectRow {
  folder: string;
  directory: string;
  kind: "folder" | "codeProject";
  name: string;
  latestRun: { id: string; status: string; task: string; reviewOf?: string | null } | null;
}

function isProjectRow(value: unknown): value is ProjectRow {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.folder === "string" && typeof r.directory === "string" && typeof r.name === "string"
    && (r.kind === "folder" || r.kind === "codeProject");
}

/** The route answers a bare array or `{ projects }`; both read the same. */
function projectRowsOf(data: unknown): ProjectRow[] {
  const list = Array.isArray(data) ? data : (data as { projects?: unknown } | null)?.projects;
  return Array.isArray(list) ? list.filter(isProjectRow) : [];
}

type WizardMode = "new" | "existing";

/**
 * The names the pictures are staged under. A clipboard picture arrives as the
 * generic "image.png"; it is stamped so a burst of pastes in one millisecond
 * cannot collide on disk (the chat composer's rule).
 */
function stagedNames(files: File[]): string[] {
  const stamp = Date.now();
  return files.map((file, idx) => {
    const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
    return generic ? `plan-${stamp}-${idx}.${file.type.split("/")[1] || "png"}` : file.name;
  });
}

let imageKeySeq = 0;
const nextImageKey = () => `img-${Date.now().toString(36)}-${(imageKeySeq += 1)}`;

/**
 * Apply an edit to the textarea so the browser's own UNDO still works: the
 * changed span is selected and replaced through `insertText`, which records
 * one undo step, and fires the input event React reads. Where the command is
 * missing (jsdom, an old engine) the value is set directly. The caret then
 * goes where the edit says.
 */
function applyToTextarea(el: HTMLTextAreaElement | null, current: string, edit: EditResult, setValue: (v: string) => void): void {
  let done = false;
  if (el && typeof document !== "undefined" && typeof document.execCommand === "function") {
    let p = 0;
    const max = Math.min(current.length, edit.value.length);
    while (p < max && current[p] === edit.value[p]) p += 1;
    let s = 0;
    while (s < max - p && current[current.length - 1 - s] === edit.value[edit.value.length - 1 - s]) s += 1;
    const replacement = edit.value.slice(p, edit.value.length - s);
    try {
      el.focus();
      // A hidden editor (Preview showing) cannot take focus, and the command
      // types into whatever HAS it — never anything but the editor.
      if (document.activeElement !== el) throw new Error("editor not focused");
      el.setSelectionRange(p, current.length - s);
      done = replacement ? document.execCommand("insertText", false, replacement) : document.execCommand("delete", false);
      // The command ran but the text is not what it should be: put it right.
      if (done && el.value !== edit.value) done = false;
    } catch {
      done = false;
    }
  }
  if (!done) setValue(edit.value);
  if (el) {
    const place = () => {
      try { el.setSelectionRange(edit.selectionStart, edit.selectionEnd); } catch { /* detached */ }
    };
    if (done) place();
    else requestAnimationFrame(place);
  }
}

/** One toolbar button: an icon, a name for the screen reader and the tooltip. */
function ToolButton({ icon, label, onClick, testId, active = false }: { icon: string; label: string; onClick: () => void; testId: string; active?: boolean }) {
  return (
    <button
      type="button"
      // The editor keeps its selection: a mousedown on the button would take focus first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      data-testid={testId}
      className={`h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md transition-colors cursor-pointer ${
        active ? "bg-white/[0.10] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06]"
      }`}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">{icon}</span>
    </button>
  );
}

/**
 * One switch row, drawn as the app's switches (SettingsApp's `Toggle`): a
 * 44-px row, the label and a one-line hint on the left, a `role="switch"`
 * button on the right, coral when on.
 */
function ToggleRow({ label, hint, on, onToggle, testId }: { label: string; hint: string; on: boolean; onToggle: (on: boolean) => void; testId: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight text-[var(--text-primary)]">{label}</p>
        <p className="text-[11px] leading-snug text-[var(--text-muted)]">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onToggle(!on)}
        data-testid={testId}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-none transition-colors ${on ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

export interface NewAppWizardCardProps {
  /** The run route's `maxTaskChars`, when the caller has read it. */
  maxTaskChars?: number;
  /** Cancel, and Create once the message is in the chat. */
  onClose: () => void;
  /** After Create only: the message has been handed to the chat. */
  onHanded?: () => void;
  /** Open in the existing-project mode with this directory picked. */
  initialProject?: string;
  /** Open with the team switch on: the message asks for coding_team_run. */
  initialTeam?: boolean;
}

export default function NewAppWizardCard({
  maxTaskChars = DEFAULT_MAX_TASK_CHARS,
  onClose,
  onHanded,
  initialProject,
  initialTeam,
}: NewAppWizardCardProps) {
  const { t } = useT();
  // The draft, read once: what the owner left here last time. An opener that
  // names a project wins over the draft's mode and project, never over its text.
  const [draft] = useState(readDraft);
  const [mode, setMode] = useState<WizardMode>(initialProject ? "existing" : draft?.mode ?? "new");
  const [name, setName] = useState(draft?.name ?? "");
  const [brief, setBrief] = useState(draft?.brief ?? "");
  const [template, setTemplate] = useState<NewAppTemplate>(draft?.template ?? DEFAULT_NEW_APP_TEMPLATE);
  const [projectDir, setProjectDir] = useState(initialProject ?? draft?.projectDir ?? "");
  const [images, setImages] = useState<PlannerImage[]>(() => (draft?.images ?? []).map((i) => ({ key: nextImageKey(), name: i.name, path: i.path })));
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // The switches: a team, ultracode, and "show me the plan first". A host that
  // opens the planner FOR a team wins over the remembered choice.
  const [team, setTeam] = useState(() => initialTeam === true || rememberedToggle("team"));
  const [ultracode, setUltracode] = useState(() => rememberedToggle("ultracode"));
  const [planFirst, setPlanFirst] = useState(() => rememberedToggle("planFirst"));
  const toggleTeam = (on: boolean) => { setTeam(on); rememberToggle("team", on); };
  const toggleUltracode = (on: boolean) => { setUltracode(on); rememberToggle("ultracode", on); };
  const togglePlanFirst = (on: boolean) => { setPlanFirst(on); rememberToggle("planFirst", on); };

  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // The owner's projects, read the first time the existing-project mode is
  // opened: null until then, [] when the box has none (or could not say).
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  useEffect(() => {
    if (mode !== "existing" || projects !== null) return;
    let active = true;
    fetch("/setup-api/coding-agent/projects", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => { if (active) setProjects(projectRowsOf(data)); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [mode, projects]);
  const project = projects?.find((p) => p.directory === projectDir) ?? null;

  // First focus: the name for a new app with none yet, otherwise the brief.
  useLayoutEffect(() => {
    if (mode === "new" && !name) nameRef.current?.focus();
    else editorRef.current?.focus();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft, kept as the owner types (debounced), and dropped when there is
  // nothing in it. Uploads in flight are not saved — they have no path yet —
  // and neither are their `[image N]` tokens: a draft restored with a token
  // and no picture would name something the run never gets. The later
  // pictures' numbers move down to match what IS saved.
  const stableImages = images.filter((i) => i.path && !i.uploading).map((i) => ({ name: i.name, path: i.path }));
  let savedBrief = brief;
  for (let i = images.length - 1; i >= 0; i -= 1) {
    if (images[i].uploading || !images[i].path) savedBrief = renumberImageTokens(savedBrief, i + 1);
  }
  const draftJson = JSON.stringify({ mode, name, brief: savedBrief, template, projectDir, images: stableImages });
  // The draft as storage holds it now — what the planner opened with, then
  // every write. A close writes only when what is on screen differs from it.
  const writtenRef = useRef<string>(draftJson);
  const handedRef = useRef(false);
  const latestDraftRef = useRef(draftJson);
  useEffect(() => { latestDraftRef.current = draftJson; }, [draftJson]);
  const persist = useCallback((json: string): boolean => {
    if (handedRef.current || json === writtenRef.current) return false;
    const d = JSON.parse(json) as PlannerDraft;
    const empty = draftIsEmpty(d);
    writeDraft(empty ? null : d);
    writtenRef.current = json;
    return !empty;
  }, []);
  useEffect(() => {
    if (draftJson === writtenRef.current) return;
    const timer = setTimeout(() => {
      setSavedAt(persist(draftJson) ? Date.now() : null);
    }, 400);
    return () => clearTimeout(timer);
  }, [draftJson, persist]);
  // Closed inside the debounce (Escape, Cancel, the window's X) or the page
  // going away (a refresh does not promise React's cleanup): the last
  // keystrokes are written on the way out — unless Create handed the plan
  // over, the one close that clears the draft.
  useEffect(() => {
    const flush = () => { persist(latestDraftRef.current); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persist]);

  // Object URLs pin their Blob until revoked: released when the window goes.
  const imagesRef = useRef(images);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => revokePreviews(imagesRef.current), []);
  // Uploads that land after the window closed must not touch its state.
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const edit = useCallback((fn: (value: string, s: number, e: number) => EditResult | null) => {
    const el = editorRef.current;
    const value = el?.value ?? brief;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const result = fn(value, s, e);
    if (!result) return false;
    applyToTextarea(el, value, result, (v) => { setBrief(v); setError(null); });
    return true;
  }, [brief]);

  const lineStyle = (style: LineStyle) => { setView("write"); edit((v, s, e) => toggleLineStyle(v, s, e, style)); };
  const wrap = (before: string, after: string, placeholderKey: string) => {
    setView("write");
    edit((v, s, e) => wrapSelection(v, s, e, before, after, t(placeholderKey)));
  };
  const addSection = (section: PlanSection) => {
    setSectionsOpen(false);
    setView("write");
    edit((v, s, e) => insertBlock(v, s, e, `## ${t(SECTION_KEY[section])}\n${SECTION_START[section]}`));
  };

  // ── Pictures ──
  const addImages = (files: File[]) => {
    let pictures = files.filter((f) => typeof f.type === "string" && f.type.startsWith("image/"));
    if (pictures.length === 0) {
      if (files.length > 0) setError(t("codingAgent.planner.imageOnly"));
      return;
    }
    // Too big for the staging route: refused here, before a thumbnail or a
    // token is made for a picture that could never arrive.
    const tooBig = pictures.filter((f) => f.size > CHAT_ATTACHMENT_MAX_BYTES);
    if (tooBig.length > 0) {
      setError(t("codingAgent.planner.imageFailed", { name: tooBig[0].name || "image" }));
      pictures = pictures.filter((f) => f.size <= CHAT_ATTACHMENT_MAX_BYTES);
      if (pictures.length === 0) return;
    }
    const room = PLANNER_MAX_IMAGES - images.length;
    if (room <= 0) { setError(t("codingAgent.planner.imageTooMany", { max: PLANNER_MAX_IMAGES })); return; }
    const taken = pictures.slice(0, room);
    if (pictures.length > room) setError(t("codingAgent.planner.imageTooMany", { max: PLANNER_MAX_IMAGES }));
    else if (tooBig.length === 0) setError(null);
    const entries: PlannerImage[] = stagedNames(taken).map((name, idx) => (
      { key: nextImageKey(), name, path: "", previewUrl: createPreviewUrl(taken[idx]), uploading: true }
    ));
    // The pictures' tokens go in at the caret now, numbered after the ones
    // already in the strip, so the brief says where each belongs.
    const first = images.length + 1;
    const tokens = entries.map((_, i) => imageToken(first + i)).join(" ");
    setView("write");
    edit((v, s, e) => insertText(v, s, e, (s > 0 && !/\s$/.test(v.slice(0, s)) ? " " : "") + tokens + " "));
    setImages((prev) => [...prev, ...entries]);
    taken.forEach((file, idx) => { void upload(file, entries[idx]); });
  };

  const removeImage = (key: string) => {
    const index = images.findIndex((i) => i.key === key);
    if (index === -1) return;
    revokePreviews([images[index]]);
    setImages((prev) => prev.filter((i) => i.key !== key));
    setBrief((b) => renumberImageTokens(b, index + 1));
  };

  const upload = async (file: File, entry: PlannerImage) => {
    const fail = () => {
      if (!aliveRef.current) { revokePreviews([entry]); return; }
      setError(t("codingAgent.planner.imageFailed", { name: entry.name }));
      // Taken out of the strip and the brief together, by its place NOW.
      const index = imagesRef.current.findIndex((i) => i.key === entry.key);
      if (index !== -1) {
        setImages((prev) => prev.filter((i) => i.key !== entry.key));
        setBrief((b) => renumberImageTokens(b, index + 1));
      }
      revokePreviews([entry]);
    };
    try {
      const form = new FormData();
      form.append("file", file, entry.name);
      const res = await fetch("/setup-api/chat/attachments", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { name?: unknown; path?: unknown };
      const path = typeof json.path === "string" ? json.path.trim() : "";
      if (!res.ok || !path) { fail(); return; }
      if (!aliveRef.current) { revokePreviews([entry]); return; }
      const name = typeof json.name === "string" && json.name.trim() ? json.name : entry.name;
      setImages((prev) => prev.map((i) => (i.key === entry.key ? { ...i, name, path, uploading: false } : i)));
    } catch {
      fail();
    }
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    addImages(files);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    setDragOver(false);
    if (files.length === 0) return;
    e.preventDefault();
    addImages(files);
  };

  // ── Keys ──
  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter") { e.preventDefault(); create(); return; }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); wrap("**", "**", "codingAgent.planner.placeholderBold"); return; }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "i" || e.key === "I")) { e.preventDefault(); wrap("_", "_", "codingAgent.planner.placeholderItalic"); return; }
    if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
      if (edit((v, s, end) => continueList(v, s, end))) e.preventDefault();
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      if (edit((v, s, end) => indentLines(v, s, end, e.shiftKey))) e.preventDefault();
    }
  };

  // ── The plan check ──
  const checks: PlanChecks = planChecks(brief, images.length, [t(SECTION_KEY.done), ...DONE_HEADINGS_EN]);
  const score = planScore(checks);
  const CHECK_ROWS: { id: keyof PlanChecks; label: string; section: PlanSection | null }[] = [
    { id: "goal", label: t("codingAgent.planner.checkGoal"), section: "goal" },
    { id: "features", label: t("codingAgent.planner.checkFeatures"), section: "features" },
    { id: "done", label: t("codingAgent.planner.checkDone"), section: "done" },
    { id: "references", label: t("codingAgent.planner.checkReferences"), section: null },
  ];

  // ── Create ──
  const references = images.filter((i) => i.path && !i.uploading).map((i) => i.path);
  const uploading = images.some((i) => i.uploading);
  const create = () => {
    if (uploading) return setError(t("codingAgent.planner.imageUploading"));
    const trimmedBrief = brief.trim();
    if (trimmedBrief.length > maxTaskChars) return setError(t("codingAgent.newWhatTooLong", { max: maxTaskChars }));
    const opts = { team, ultracode, planFirst, references };
    if (mode === "existing") {
      if (!project) return setError(t("codingAgent.newProjectRequired"));
      if (!trimmedBrief) return setError(t("codingAgent.newWhatRequired"));
      const req = {
        name: project.name,
        directory: project.directory,
        kind: project.kind,
        folder: project.folder,
        instructions: trimmedBrief,
        latestRun: project.latestRun,
      };
      dispatchChatMessage(team ? buildTeamProjectPrompt(req, opts) : buildResumeProjectPrompt(req, opts));
    } else {
      const trimmedName = name.trim();
      if (!trimmedName) { nameRef.current?.focus(); return setError(t("codingAgent.newNameRequired")); }
      if (trimmedName.length > NEW_APP_NAME_MAX) return setError(t("codingAgent.newNameTooLong", { max: NEW_APP_NAME_MAX }));
      if (!trimmedBrief) return setError(t("codingAgent.newWhatRequired"));
      dispatchChatMessage(buildNewAppPrompt({ name: trimmedName, description: trimmedBrief, template }, opts));
    }
    setError(null);
    // Handed over: the draft has done its job.
    handedRef.current = true;
    writeDraft(null);
    onClose();
    onHanded?.();
  };

  const clearAll = () => {
    if (!clearArmed) { setClearArmed(true); return; }
    setClearArmed(false);
    revokePreviews(images);
    setImages([]);
    setBrief("");
    setName("");
    setError(null);
    writeDraft(null);
    setSavedAt(null);
    editorRef.current?.focus();
  };
  // The sections menu closes on a press anywhere outside it.
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sectionsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (sectionsRef.current && e.target instanceof Node && sectionsRef.current.contains(e.target)) return;
      setSectionsOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [sectionsOpen]);

  // An armed Clear disarms itself.
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 3_000);
    return () => clearTimeout(timer);
  }, [clearArmed]);

  const count = brief.trim().length;
  const over = count > maxTaskChars;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); create(); }}
      data-testid="coding-agent-new-card"
      className="@container h-full flex flex-col bg-[var(--surface-1,#16171b)] text-[var(--text-primary)]"
    >
      {/* ── Head: the mode, then the name or the project ── */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-white/[0.06] space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--coral-bright)]">{t("codingAgent.planner.kicker")}</p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{t(mode === "existing" ? "codingAgent.newModeExisting" : "codingAgent.newTitle")}</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-black/25 border border-white/[0.10] p-1" role="group" aria-label={t("codingAgent.newTitle")}>
            {(["new", "existing"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => { setMode(m); setError(null); }}
                data-testid={`coding-agent-new-mode-${m}`}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  mode === m ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {t(m === "new" ? "codingAgent.newModeNew" : "codingAgent.newModeExisting")}
              </button>
            ))}
          </div>
        </div>
        {mode === "existing" ? (
          <div className="space-y-1.5">
            <label className={LABEL}>
              {t("codingAgent.newProjectLabel")}
              <select
                value={projectDir}
                onChange={(e) => { setProjectDir(e.target.value); setError(null); }}
                disabled={projects === null || projects.length === 0}
                data-testid="coding-agent-new-project"
                className={`${FIELD} ${SELECT} mt-1.5 appearance-none bg-[var(--bg-elevated)] pr-9`}
              >
                <option value="">
                  {projects === null ? t("codingAgent.newProjectsLoading") : projects.length === 0 ? t("codingAgent.newNoProjects") : "—"}
                </option>
                {(projects ?? []).map((p) => (
                  <option key={p.directory} value={p.directory}>
                    {p.name} · {t(p.kind === "codeProject" ? "codingAgent.newKindCodeProject" : "codingAgent.newKindFolder")}
                  </option>
                ))}
              </select>
            </label>
            {project?.latestRun && (
              <p className="text-[11px] text-[var(--text-muted)] break-words" data-testid="coding-agent-new-last-run">
                {t("codingAgent.newLastRun", { task: lastRunLabel(project.latestRun, t) })}
              </p>
            )}
          </div>
        ) : (
          <label className={LABEL}>
            {t("codingAgent.newNameLabel")}
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => {
                // Enter in the name moves on to the brief rather than sending a plan with no body.
                if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); editorRef.current?.focus(); }
              }}
              maxLength={NEW_APP_NAME_MAX}
              placeholder={t("codingAgent.newNamePlaceholder")}
              data-testid="coding-agent-new-name"
              className={`${FIELD} mt-1.5`}
            />
          </label>
        )}
      </div>

      {/* ── Body: the editor, and the plan's side panel ── */}
      <div className="flex-1 min-h-0 overflow-y-auto @3xl:overflow-hidden flex flex-col @3xl:flex-row">
        <div
          className={`relative flex-1 min-w-0 min-h-[18rem] flex flex-col ${dragOver ? "ring-2 ring-inset ring-[var(--coral-bright)]/50" : ""}`}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          data-testid="coding-agent-planner-editor"
        >
          {/* Toolbar */}
          <div className="shrink-0 flex items-center gap-0.5 px-3 py-1.5 border-b border-white/[0.06] overflow-x-auto" role="toolbar" aria-label={t("codingAgent.planner.toolbar")}>
            <ToolButton icon="title" label={t("codingAgent.planner.toolHeading")} onClick={() => lineStyle("heading")} testId="coding-agent-planner-tool-heading" />
            <ToolButton icon="format_bold" label={t("codingAgent.planner.toolBold")} onClick={() => wrap("**", "**", "codingAgent.planner.placeholderBold")} testId="coding-agent-planner-tool-bold" />
            <ToolButton icon="format_italic" label={t("codingAgent.planner.toolItalic")} onClick={() => wrap("_", "_", "codingAgent.planner.placeholderItalic")} testId="coding-agent-planner-tool-italic" />
            <span className="mx-1 h-5 w-px bg-white/[0.08]" aria-hidden="true" />
            <ToolButton icon="format_list_bulleted" label={t("codingAgent.planner.toolBullet")} onClick={() => lineStyle("bullet")} testId="coding-agent-planner-tool-bullet" />
            <ToolButton icon="format_list_numbered" label={t("codingAgent.planner.toolNumber")} onClick={() => lineStyle("number")} testId="coding-agent-planner-tool-number" />
            <ToolButton icon="checklist" label={t("codingAgent.planner.toolCheck")} onClick={() => lineStyle("check")} testId="coding-agent-planner-tool-check" />
            <ToolButton icon="format_quote" label={t("codingAgent.planner.toolQuote")} onClick={() => lineStyle("quote")} testId="coding-agent-planner-tool-quote" />
            <ToolButton icon="code" label={t("codingAgent.planner.toolCode")} onClick={() => wrap("`", "`", "codingAgent.planner.placeholderCode")} testId="coding-agent-planner-tool-code" />
            <span className="mx-1 h-5 w-px bg-white/[0.08]" aria-hidden="true" />
            <ToolButton icon="add_photo_alternate" label={t("codingAgent.planner.toolImage")} onClick={() => fileInputRef.current?.click()} testId="coding-agent-planner-tool-image" />
            <div className="relative" ref={sectionsRef}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSectionsOpen((o) => !o)}
                aria-expanded={sectionsOpen}
                aria-haspopup="menu"
                data-testid="coding-agent-planner-sections"
                className="h-8 inline-flex items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">playlist_add</span>
                {t("codingAgent.planner.toolSection")}
              </button>
              {sectionsOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-full mt-1 z-10 w-52 rounded-lg border border-white/[0.10] bg-[var(--bg-elevated,#202227)] p-1 shadow-xl"
                  // Handled here: `preventDefault` tells the window not to close on the same key.
                  onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSectionsOpen(false); } }}
                  data-testid="coding-agent-planner-sections-menu"
                >
                  {PLAN_SECTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addSection(s)}
                      data-testid={`coding-agent-planner-section-${s}`}
                      className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      {t(SECTION_KEY[s])}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="ml-auto flex gap-0.5 rounded-md bg-black/25 p-0.5" role="group" aria-label={t("codingAgent.planner.viewLabel")}>
              {(["write", "preview"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  data-testid={`coding-agent-planner-view-${v}`}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium cursor-pointer ${view === v ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
                >
                  {t(v === "write" ? "codingAgent.planner.viewWrite" : "codingAgent.planner.viewPreview")}
                </button>
              ))}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              data-testid="coding-agent-planner-file"
              onChange={(e) => { addImages(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
          </div>

          {/* The brief */}
          <label className="sr-only" htmlFor="coding-agent-planner-brief">
            {t(mode === "existing" ? "codingAgent.newNextLabel" : "codingAgent.planner.briefLabel")}
          </label>
          <textarea
            id="coding-agent-planner-brief"
            ref={editorRef}
            value={brief}
            onChange={(e) => { setBrief(e.target.value); setError(null); }}
            onKeyDown={onEditorKeyDown}
            onPaste={onPaste}
            placeholder={t(mode === "existing" ? "codingAgent.planner.briefPlaceholderExisting" : "codingAgent.planner.briefPlaceholder")}
            spellCheck
            // Two ids for the one editor: what a new app should be, and what an
            // existing project's next run should do.
            data-testid={mode === "existing" ? "coding-agent-new-next" : "coding-agent-new-what"}
            hidden={view === "preview"}
            className="flex-1 min-h-[12rem] w-full resize-none bg-transparent px-5 py-4 text-sm leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 outline-none font-[inherit]"
          />
          {view === "preview" && (
            <div className={`flex-1 min-h-[12rem] overflow-y-auto px-5 py-4 ${PREVIEW}`} data-testid="coding-agent-planner-preview">
              {brief.trim() ? renderText(brief, t("chat.table")) : <p className="text-[var(--text-muted)]">{t("codingAgent.planner.previewEmpty")}</p>}
            </div>
          )}

          {/* The pictures */}
          {images.length > 0 && (
            <div className="shrink-0 border-t border-white/[0.06] px-5 py-2.5" data-testid="coding-agent-planner-images">
              <ul className="flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <li key={img.key} className="group relative" data-testid="coding-agent-planner-image">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => edit((v, s, e) => insertText(v, s, e, imageToken(i + 1)))}
                      title={t("codingAgent.planner.imageInsert", { n: i + 1 })}
                      aria-label={t("codingAgent.planner.imageInsert", { n: i + 1 })}
                      className="block h-16 w-16 overflow-hidden rounded-lg border border-white/[0.10] bg-black/30 cursor-pointer"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- a staged picture on the box, not a page asset */}
                      <img
                        src={img.previewUrl ?? (img.path ? mediaUrl(img.path) : undefined)}
                        alt={img.name}
                        draggable={false}
                        className={`h-full w-full object-cover ${img.uploading ? "opacity-40" : ""}`}
                      />
                      {img.uploading && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-label={t("codingAgent.planner.imageUploading")} />
                        </span>
                      )}
                    </button>
                    <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white">{i + 1}</span>
                    <button
                      type="button"
                      onClick={() => removeImage(img.key)}
                      aria-label={t("codingAgent.planner.imageRemove", { name: img.name })}
                      title={t("codingAgent.planner.imageRemove", { name: img.name })}
                      data-testid="coding-agent-planner-image-remove"
                      className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-black/80 border border-white/20 text-white/80 hover:text-white hover:bg-red-500/80 flex items-center justify-center cursor-pointer"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 13 }} aria-hidden="true">close</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Status line */}
          <div className="shrink-0 flex items-center gap-3 px-5 py-1.5 border-t border-white/[0.06] text-[11px] text-[var(--text-muted)]">
            <span className="truncate">{t("codingAgent.planner.imagesHint")}</span>
            <span className="ml-auto shrink-0 tabular-nums" data-testid="coding-agent-planner-count">
              <span className={over ? "text-amber-400" : ""}>{count.toLocaleString()}</span> / {maxTaskChars.toLocaleString()}
            </span>
          </div>
        </div>

        {/* ── Side panel: the plan check, the starter, the switches ── */}
        <aside className="shrink-0 @3xl:w-72 @3xl:overflow-y-auto border-t @3xl:border-t-0 @3xl:border-l border-white/[0.06] px-4 py-4 space-y-5">
          <section data-testid="coding-agent-planner-checks">
            <div className="flex items-center justify-between">
              <p className={SIDE_LABEL}>{t("codingAgent.planner.checksTitle")}</p>
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]" data-testid="coding-agent-planner-score">{score}/3</span>
            </div>
            <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-[var(--coral-bright)] transition-[width] duration-300" style={{ width: `${(score / 3) * 100}%` }} />
            </div>
            <ul className="mt-2.5 space-y-1">
              {CHECK_ROWS.map((row) => {
                const ok = checks[row.id];
                const act = row.section
                  ? () => addSection(row.section as PlanSection)
                  : () => fileInputRef.current?.click();
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={ok ? undefined : act}
                      disabled={ok}
                      data-testid={`coding-agent-planner-check-${row.id}`}
                      data-ok={ok ? "true" : "false"}
                      className={`w-full flex items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs ${ok ? "text-[var(--text-secondary)] cursor-default" : "text-[var(--text-muted)] hover:bg-white/[0.04] hover:text-[var(--text-secondary)] cursor-pointer"}`}
                    >
                      <span
                        className={`material-symbols-rounded shrink-0 ${ok ? "text-emerald-400" : "text-[var(--text-muted)]"}`}
                        style={{ fontSize: 16 }}
                        aria-hidden="true"
                      >
                        {ok ? "check_circle" : "radio_button_unchecked"}
                      </span>
                      <span>{row.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-muted)] opacity-80">{t("codingAgent.planner.checksHint")}</p>
          </section>

          {mode === "new" && (
            <section>
              <label className={SIDE_LABEL}>
                {t("codingAgent.newTemplateLabel")}
                <select
                  value={template}
                  onChange={(e) => setTemplate(e.target.value as NewAppTemplate)}
                  data-testid="coding-agent-new-template"
                  className={`${FIELD} ${SELECT} mt-1.5 appearance-none bg-[var(--bg-elevated)] pr-9 normal-case tracking-normal font-normal`}
                >
                  {NEW_APP_TEMPLATES.map((tpl) => (
                    <option key={tpl} value={tpl}>
                      {t(NEW_APP_TEMPLATE_LABEL[tpl])}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}

          <section className="space-y-2" data-testid="coding-agent-new-toggles">
            <p className={SIDE_LABEL}>{t("codingAgent.planner.howTitle")}</p>
            <ToggleRow label={t("codingAgent.newTeamSwitch")} hint={t("codingAgent.newTeamHint")} on={team} onToggle={toggleTeam} testId="coding-agent-new-team" />
            <ToggleRow label={t("codingAgent.newUltracodeSwitch")} hint={t("codingAgent.newUltracodeHint")} on={ultracode} onToggle={toggleUltracode} testId="coding-agent-new-ultracode" />
            <ToggleRow label={t("codingAgent.planner.planFirstSwitch")} hint={t("codingAgent.planner.planFirstHint")} on={planFirst} onToggle={togglePlanFirst} testId="coding-agent-new-plan-first" />
          </section>
        </aside>
      </div>

      {/* ── Foot: what went wrong, the draft, the buttons ── */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-5 py-3 border-t border-white/[0.06]">
        <div className="min-w-0 flex-1">
          {error ? (
            <p className="text-[11px] text-amber-400" role="alert" data-testid="coding-agent-new-error">{error}</p>
          ) : savedAt ? (
            <p className="text-[11px] text-[var(--text-muted)] flex items-center gap-1" data-testid="coding-agent-planner-saved">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">cloud_done</span>
              {t("codingAgent.planner.draftSaved")}
            </p>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)] opacity-70 hidden @md:block">{t("codingAgent.planner.shortcutHint")}</p>
          )}
        </div>
        <button
          type="button"
          onClick={clearAll}
          data-testid="coding-agent-planner-clear"
          className={`text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer ${clearArmed ? "border-red-400/50 text-red-300 bg-red-500/10" : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"}`}
        >
          {t(clearArmed ? "codingAgent.planner.clearConfirm" : "codingAgent.planner.clear")}
        </button>
        <button
          type="button"
          onClick={onClose}
          data-testid="coding-agent-new-cancel"
          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5 cursor-pointer"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          data-testid="coding-agent-new-create"
          disabled={uploading}
          className="text-xs px-4 py-1.5 rounded-lg bg-[var(--coral-bright)] text-black font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          {t(planFirst ? "codingAgent.planner.askForPlan" : team ? "codingAgent.newStartTeam" : mode === "existing" ? "codingAgent.newContinue" : "codingAgent.newCreate")}
        </button>
      </div>
    </form>
  );
}
