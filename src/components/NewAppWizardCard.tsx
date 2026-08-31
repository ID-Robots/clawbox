"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  buildNewAppPrompt,
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

export interface NewAppWizardCardProps {
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
}: NewAppWizardCardProps) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const [template, setTemplate] = useState<NewAppTemplate>(DEFAULT_NEW_APP_TEMPLATE);
  const [error, setError] = useState<string | null>(null);

  /**
   * Create: check what the assistant would refuse, compose the one message,
   * hand it to the chat, and get out of the way.
   */
  const create = () => {
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
      onSubmit={(e) => { e.preventDefault(); create(); }}
      data-testid="coding-agent-new-card"
      className={`rounded-xl bg-white/[0.03] border border-[var(--coral-bright)]/30 px-3 py-3 space-y-2.5 ${className}`}
    >
      <p className="text-xs font-medium text-[var(--text-primary)]">{t("codingAgent.newTitle")}</p>
      <label className="block text-[11px] text-[var(--text-muted)]">
        {t("codingAgent.newNameLabel")}
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          maxLength={NEW_APP_NAME_MAX}
          placeholder={t("codingAgent.newNamePlaceholder")}
          autoFocus
          data-testid="coding-agent-new-name"
          className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-base sm:text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:outline-none focus:border-[var(--coral-bright)]/60"
        />
      </label>
      <label className="block text-[11px] text-[var(--text-muted)]">
        {t("codingAgent.newWhatLabel")}
        <textarea
          value={what}
          onChange={(e) => { setWhat(e.target.value); setError(null); }}
          maxLength={maxTaskChars}
          rows={3}
          placeholder={t("codingAgent.newWhatPlaceholder")}
          data-testid="coding-agent-new-what"
          className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-base sm:text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:outline-none focus:border-[var(--coral-bright)]/60 resize-y"
        />
      </label>
      <label className="block text-[11px] text-[var(--text-muted)]">
        {t("codingAgent.newTemplateLabel")}
        <select
          value={template}
          onChange={(e) => setTemplate(e.target.value as NewAppTemplate)}
          data-testid="coding-agent-new-template"
          className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-base sm:text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]/60"
        >
          {NEW_APP_TEMPLATES.map((tpl) => (
            <option key={tpl} value={tpl}>
              {t(NEW_APP_TEMPLATE_LABEL[tpl])}
            </option>
          ))}
        </select>
      </label>
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
          {t("codingAgent.newCreate")}
        </button>
      </div>
    </form>
  );
}
