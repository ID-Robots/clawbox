import type { CSSProperties } from "react";
import { runModelId, codingModelName, teamModelsLabel, type RunModelFields } from "@/lib/coding-model-names";

/**
 * The model a coding run (or a team) runs on, as ONE small quiet chip — the
 * owner's ask of 2026-11-01: "Show Provider model name like "Opus 5.5" or
 * "GPT 5.6 Sol" in coding agent agent diagrams, in the main chat coding agent
 * pill and other places if it makes sence". The same chip on every surface:
 * the agent chart's nodes, the chat's run and team cards, home's Now rows and
 * the Team page's member rows.
 *
 * Inline styles rather than Tailwind so the chat's cards (inline-styled
 * throughout) and the app's Tailwind surfaces draw exactly the same chip.
 * The name is a product name — the same in every language — and the full id
 * is its tooltip. Draws NOTHING when no model is known: a model is never
 * invented.
 */
const CHIP: CSSProperties = {
  display: "inline-block",
  maxWidth: "100%",
  height: 16,
  lineHeight: "16px",
  padding: "0 6px",
  borderRadius: 8,
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: 0.1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.6)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  verticalAlign: "middle",
  boxSizing: "border-box",
  flexShrink: 1,
  minWidth: 0,
};

/** The extra-small chip under a node of the agent chart. */
const CHIP_XS: CSSProperties = { height: 13, lineHeight: "11px", padding: "0 5px", borderRadius: 7, fontSize: 9 };

export default function CodingModelChip({ label, title, size = "sm", testId = "coding-model-chip", style }: {
  /** The short name(s) to show; null or empty draws nothing. */
  label: string | null | undefined;
  /** The full id(s), for the tooltip. Defaults to the label. */
  title?: string | null;
  size?: "sm" | "xs";
  testId?: string;
  style?: CSSProperties;
}) {
  if (!label) return null;
  return (
    <span
      data-testid={testId}
      title={title || label}
      style={{ ...CHIP, ...(size === "xs" ? CHIP_XS : null), ...style }}
    >
      {label}
    </span>
  );
}

/** The chip for ONE run: its short name, its full id as the tooltip. */
export function RunModelChip({ run, ...rest }: { run: RunModelFields | null | undefined } & Omit<Parameters<typeof CodingModelChip>[0], "label" | "title">) {
  const id = runModelId(run);
  return <CodingModelChip label={id ? codingModelName(id) : null} title={id} {...rest} />;
}

/** The chip for a TEAM: its members' distinct short names, the workers' first, at most two then "+N". */
export function TeamModelChip({ members, ...rest }: { members: Parameters<typeof teamModelsLabel>[0] } & Omit<Parameters<typeof CodingModelChip>[0], "label" | "title">) {
  const models = teamModelsLabel(members);
  return <CodingModelChip label={models?.label} title={models?.ids.join(", ")} {...rest} />;
}
