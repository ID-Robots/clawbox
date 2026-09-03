"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  buildNewAppPrompt,
  buildResumeProjectPrompt,
  DEFAULT_NEW_APP_TEMPLATE,
  NEW_APP_TEMPLATES,
  dispatchChatMessage,
  type NewAppTemplate,
} from "@/lib/ui-events";

/**
 * The New app wizard — ONE card, two homes.
 *
 * It composes a single message ("Create a new ClawBox app called …") and
 * hands it to the mascot chat through `dispatchChatMessage`; the assistant
 * carries on from there with the tools it has (code_project_init,
 * coding_agent_run, the browser, the desktop). It never calls the run route
 * itself: the run is the assistant's to start, with the project it has just
 * scaffolded, and the owner is in the chat to watch it happen.
 *
 * It used to be inlined in the Coding Agent app. The chat composer's Create
 * button opens the same card, so the form lives here and both render it —
 * one set of fields, one validation, one message.
 *
 * Two modes since the owner asked for it: a NEW app, or an EXISTING project
 * (the same list the Coding Agent app shows — git folders under the project
 * folder and code projects) with "what should the next run do?", composed
 * as a message that tells the assistant how to resume that project rather
 * than scaffold a new one (buildResumeProjectPrompt).
 */

/**
 * The longest name the wizard accepts — the same bound as
 * assertProjectName in src/lib/code-projects.ts (MAX_PROJECT_NAME_LENGTH),
 * which is what refuses the name once the assistant scaffolds the project.
 * Checked here so the owner hears it before the handoff, not from a tool
 * error in the chat. Exported so a test can pin the two together; a client
 * component cannot import the library constant, which pulls in fs.
 */
export const NEW_APP_NAME_MAX = 60;

/**
 * The description ceiling when the caller has no live status to read it
 * from — the run route's own default for `maxTaskChars`. The route refuses
 * anything longer anyway; this only lets the card say so first.
 */
export const DEFAULT_MAX_TASK_CHARS = 4_000;

/** The select's option label per starter — the order and default live in ui-events. */
const NEW_APP_TEMPLATE_LABEL: Record<NewAppTemplate, string> = {
  nextjs: "codingAgent.newTemplateNextjs",
  react: "codingAgent.newTemplateReact",
  app: "codingAgent.newTemplateApp",
  blank: "codingAgent.newTemplateBlank",
};

/**
 * The card's field vocabulary.
 *
 * It used to run on `px-2.5 py-1.5 text-xs` inputs — smaller than every other
 * form on the box, and on a phone the 16px/12px split meant the same control
 * changed size across the breakpoint. One size, matched to the Coding Agent's
 * own controls and to the Settings forms: text-sm, py-2, and a focus ring in
 * the product's coral rather than a bare border change.
 */
const FIELD =
  "w-full rounded-lg bg-black/25 border border-white/[0.10] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 outline-none transition-colors focus:border-[var(--coral-bright)]/60 focus:ring-1 focus:ring-[var(--coral-bright)]/25";

const LABEL = "block text-xs font-medium text-[var(--text-secondary)]";

/** One row of GET /setup-api/coding-agent/projects, as the card reads it. */
interface ProjectRow {
  folder: string;
  directory: string;
  kind: "folder" | "codeProject";
  name: string;
  latestRun: { id: string; status: string; task: string } | null;
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

export interface NewAppWizardCardProps {
  /**
   * Close when a click lands outside the card.
   *
   * On the Coding Agent's home page the card is part of the page, and a stray
   * click on the page must not throw away what was typed. In the mascot chat it
   * floats over the composer like a popover, and there the expectation is the
   * popover one: click away and it goes.
   */
  closeOnOutsideClick?: boolean;
  /** The run route's `maxTaskChars`, when the caller has read it. */
  maxTaskChars?: number;
  /** Cancel, and Create once the message is in the chat. */
  onClose: () => void;
  /** After Create only: the message has been handed to the chat. */
  onHanded?: () => void;
  /** Extra classes on the card — the chat composer sits it on a darker ground. */
  className?: string;
}

export default function NewAppWizardCard({
  maxTaskChars = DEFAULT_MAX_TASK_CHARS,
  onClose,
  onHanded,
  className = "",
  closeOnOutsideClick = false,
}: NewAppWizardCardProps) {
  const { t } = useT();
  const cardRef = useRef<HTMLFormElement | null>(null);
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const [template, setTemplate] = useState<NewAppTemplate>(DEFAULT_NEW_APP_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<WizardMode>("new");
  // The owner's projects, read the first time the existing-project mode is
  // opened: null until then, [] when the box has none (or could not say).
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectDir, setProjectDir] = useState("");
  const [next, setNext] = useState("");
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

  /**
   * Close on a click outside the card, when the host asked for popover
   * behaviour.
   *
   * `pointerdown`, not `click`: a click that starts inside the card and ends
   * outside it (a drag from the textarea's resize handle, or selecting text and
   * releasing past the edge) is not a click away, and `click` fires on the
   * common ancestor for exactly that gesture. Escape closes it too, which is
   * the other half of what a popover owes the keyboard.
   */
  useEffect(() => {
    if (!closeOnOutsideClick || !onClose) return;
    const onPointerDown = (event: PointerEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const target = event.target as Node | null;
      if (target && !card.contains(target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeOnOutsideClick, onClose]);

  /**
   * Create: check what the assistant would refuse, compose the one message,
   * hand it to the chat, and get out of the way.
   */
  const create = () => {
    if (mode === "existing") {
      const trimmedNext = next.trim();
      if (!project) return setError(t("codingAgent.newProjectRequired"));
      if (!trimmedNext) return setError(t("codingAgent.newWhatRequired"));
      if (trimmedNext.length > maxTaskChars) return setError(t("codingAgent.newWhatTooLong", { max: maxTaskChars }));
      dispatchChatMessage(buildResumeProjectPrompt({
        name: project.name,
        directory: project.directory,
        kind: project.kind,
        folder: project.folder,
        instructions: trimmedNext,
        latestRun: project.latestRun,
      }));
      setError(null);
      onClose();
      onHanded?.();
      return;
    }
    const trimmedName = name.trim();
    const trimmedWhat = what.trim();
    if (!trimmedName) return setError(t("codingAgent.newNameRequired"));
    if (trimmedName.length > NEW_APP_NAME_MAX) return setError(t("codingAgent.newNameTooLong", { max: NEW_APP_NAME_MAX }));
    if (!trimmedWhat) return setError(t("codingAgent.newWhatRequired"));
    if (trimmedWhat.length > maxTaskChars) return setError(t("codingAgent.newWhatTooLong", { max: maxTaskChars }));
    dispatchChatMessage(buildNewAppPrompt({ name: trimmedName, description: trimmedWhat, template }));
    setError(null);
    onClose();
    onHanded?.();
  };

  return (
    <form
      ref={cardRef}
      onSubmit={(e) => { e.preventDefault(); create(); }}
      data-testid="coding-agent-new-card"
      className={`rounded-2xl bg-white/[0.03] border border-[var(--coral-bright)]/30 px-4 py-4 space-y-3.5 ${className}`}
    >
      <p className="text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.newTitle")}</p>
      {/* New app, or an existing project to continue. */}
      <div className="flex gap-1 rounded-lg bg-black/25 border border-white/[0.10] p-1" role="group" aria-label={t("codingAgent.newTitle")}>
        {(["new", "existing"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => { setMode(m); setError(null); }}
            data-testid={`coding-agent-new-mode-${m}`}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              mode === m ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {t(m === "new" ? "codingAgent.newModeNew" : "codingAgent.newModeExisting")}
          </button>
        ))}
      </div>
      {mode === "existing" ? (<>
        <label className={LABEL}>
          {t("codingAgent.newProjectLabel")}
          <select
            value={projectDir}
            onChange={(e) => { setProjectDir(e.target.value); setError(null); }}
            disabled={projects === null || projects.length === 0}
            data-testid="coding-agent-new-project"
            className={`${FIELD} mt-1.5 appearance-none bg-[var(--bg-elevated)] pr-9`}
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
            {t("codingAgent.newLastRun", { task: project.latestRun.task.trim().split(/\r?\n/)[0].slice(0, 120) })}
          </p>
        )}
        <label className={LABEL}>
          {t("codingAgent.newNextLabel")}
          <textarea
            value={next}
            onChange={(e) => { setNext(e.target.value); setError(null); }}
            maxLength={maxTaskChars}
            rows={3}
            placeholder={t("codingAgent.newNextPlaceholder")}
            data-testid="coding-agent-new-next"
            className={`${FIELD} mt-1.5 resize-y min-h-[5.5rem]`}
          />
        </label>
        <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.newExistingHint")}</p>
      </>) : (<>
      <label className={LABEL}>
        {t("codingAgent.newNameLabel")}
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          maxLength={NEW_APP_NAME_MAX}
          placeholder={t("codingAgent.newNamePlaceholder")}
          autoFocus
          data-testid="coding-agent-new-name"
          className={`${FIELD} mt-1.5`}
        />
      </label>
      <label className={LABEL}>
        {t("codingAgent.newWhatLabel")}
        <textarea
          value={what}
          onChange={(e) => { setWhat(e.target.value); setError(null); }}
          maxLength={maxTaskChars}
          rows={3}
          placeholder={t("codingAgent.newWhatPlaceholder")}
          data-testid="coding-agent-new-what"
          className={`${FIELD} mt-1.5 resize-y min-h-[5.5rem]`}
        />
      </label>
      <label className={LABEL}>
        {t("codingAgent.newTemplateLabel")}
        <select
          value={template}
          onChange={(e) => setTemplate(e.target.value as NewAppTemplate)}
          data-testid="coding-agent-new-template"
          className={`${FIELD} mt-1.5 appearance-none bg-[var(--bg-elevated)] pr-9`}
        >
          {NEW_APP_TEMPLATES.map((tpl) => (
            <option key={tpl} value={tpl}>
              {t(NEW_APP_TEMPLATE_LABEL[tpl])}
            </option>
          ))}
        </select>
      </label>
      </>)}
      {error && (
        <p className="text-[11px] text-amber-400" role="alert" data-testid="coding-agent-new-error">{error}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          data-testid="coding-agent-new-cancel"
          className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          data-testid="coding-agent-new-create"
          className="text-[11px] px-3 py-1 rounded-lg bg-[var(--coral-bright)] text-black font-medium hover:opacity-90"
        >
          {t(mode === "existing" ? "codingAgent.newContinue" : "codingAgent.newCreate")}
        </button>
      </div>
    </form>
  );
}
