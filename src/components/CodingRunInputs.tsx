"use client";

import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";

/**
 * "Inputs for this run" — the files the box handed a run, and where they live.
 *
 * WHY THIS IS ON THE PAGE AT ALL. The assistant writes what it generates into
 * its own state folder, which sits inside a credential store no run may read;
 * the box copies what a run was handed out into a folder it can. That is
 * invisible machinery until something is missing — and then the owner's
 * question is "where do I put the file?", which nothing on the device answered.
 * So the card is drawn for every run whether or not anything was staged: the
 * folder is the answer, and a folder nobody can find is a folder nobody drops a
 * file into.
 *
 * A record written before the hand-over existed has no `inputs` at all, and
 * draws nothing — never an empty inputs folder, which would be a claim this
 * build cannot make about that run.
 */

/** The refusal codes the device stores, worded from the catalogue. Folded into
 *  four sentences rather than one per code: "not absolute" and "outside the
 *  folders this box copies from" are one fact to a reader — the path is not
 *  somewhere the box takes files from — and a refusal list nobody can act on
 *  is worse than a shorter one they can. */
const REFUSAL_KEYS: Record<string, string> = {
  not_absolute: "codingAgent.inputsRefusedLocation",
  outside_roots: "codingAgent.inputsRefusedLocation",
  not_a_file: "codingAgent.inputsRefusedMissing",
  too_large: "codingAgent.inputsRefusedSize",
  too_many: "codingAgent.inputsRefusedSize",
  copy_failed: "codingAgent.inputsRefusedFailed",
};

export interface RunInputs {
  dir: string;
  shared: string;
  files?: { name: string; bytes: number }[];
  refused?: { name: string; code: string }[];
}

export default function CodingRunInputs({ inputs }: { inputs?: RunInputs | null }) {
  const { t, locale } = useT();
  if (!inputs || typeof inputs.dir !== "string" || !inputs.dir) return null;
  const files = inputs.files ?? [];
  const refused = inputs.refused ?? [];

  return (
    <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-inputs">
      <p className={SECTION_LABEL}>
        {t("codingAgent.inputsTitle")}
        {files.length > 0 && (
          <span className="ml-1.5 normal-case tracking-normal font-normal text-[var(--text-muted)]">({files.length})</span>
        )}
      </p>
      {files.length > 0 ? (
        <ul className="mt-1.5 space-y-1" data-testid="coding-agent-inputs-files">
          {files.map((f) => (
            <li key={f.name} className="flex items-baseline gap-2">
              <span className="text-[11px] font-mono text-[var(--text-secondary)] break-all">{f.name}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{formatBytes(f.bytes, locale)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-inputs-empty">
          {t("codingAgent.inputsEmpty")}
        </p>
      )}

      {refused.length > 0 && (
        <div className="mt-2" data-testid="coding-agent-inputs-refused">
          <p className="text-[11px] font-medium text-amber-400">{t("codingAgent.inputsRefusedTitle")}</p>
          <ul className="mt-1 space-y-1">
            {refused.map((r, i) => (
              <li key={`${r.name}-${i}`} className="text-[11px] text-[var(--text-muted)] break-all">
                <span className="font-mono text-[var(--text-secondary)]">{r.name}</span>
                {/* A code this build does not know says nothing rather than
                    printing the code itself: the owner reads sentences, and a
                    bare `outside_roots` on a German desktop is not one. */}
                {REFUSAL_KEYS[r.code] && <span> — {t(REFUSAL_KEYS[r.code])}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2 text-[11px] text-[var(--text-muted)] opacity-70 leading-relaxed break-all">
        {t("codingAgent.inputsHint", { folder: inputs.dir, shared: inputs.shared })}
      </p>
    </div>
  );
}
