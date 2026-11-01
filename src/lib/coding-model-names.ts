/**
 * A coding model's SHORT name, for the places that show one beside its
 * provider: the per-role choices in the Coding Agent settings, a run's first
 * step on its timeline, a teammate's row on a run's page — and, since
 * 2026-11-01 (owner: "Show Provider model name like "Opus 5.5" or "GPT 5.6
 * Sol" in coding agent agent diagrams, in the main chat coding agent pill"),
 * on every node of the agent chart, the chat's coding pill, the chat's run
 * cards, home's Now rows and the Team page's member rows (`runModelLabel`).
 *
 * Short because the provider is always said beside it
 * (`CODING_PROVIDER_NAME_KEY`): "Opus 5.5" under "Anthropic", not "Claude Opus
 * 5.5". Product names, so they live here rather than in the locale tables —
 * they read the same in every language.
 *
 * PURE, like coding-provider.ts: the settings panel imports it.
 */
const NAMES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "DeepSeek Flash",
  // The Max plan's id, served by the same Flash model.
  "deepseek-v4-pro": "DeepSeek Flash",
  "claude-opus-5-5": "Opus 5.5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "gpt-6-astra": "GPT 6 Astra",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.2": "GPT 5.2",
};

/** "astra" → "Astra"; "codex" → "Codex"; a part with digits stays as it is. */
function word(part: string): string {
  return /^[a-z]+$/.test(part) ? part[0].toUpperCase() + part.slice(1) : part;
}

/**
 * A name for an id of a KNOWN family this build has no row for: "gpt-5.7-sol"
 * → "GPT 5.7 Sol", "claude-haiku-5-2" → "Haiku 5.2". Null for any other shape.
 */
function prettify(base: string): string | null {
  // Alphabetic tail words only: a dated snapshot (gpt-5-2025-08-07) keeps its id.
  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)$/i.exec(base);
  if (gpt) {
    const rest = gpt[2].split("-").filter(Boolean).map(word);
    return ["GPT", gpt[1], ...rest].join(" ");
  }
  // claude-<family>-<major>-<minor> only — no date stamp or other tail, and
  // not a bare `claude-<word>-<n>`, which stays its id (a timeline test pins
  // "claude-next-9" unchanged).
  const claude = /^claude-([a-z]+)-(\d+)-(\d{1,2})$/i.exec(base);
  if (claude) return `${word(claude[1].toLowerCase())} ${claude[2]}.${claude[3]}`;
  return null;
}

/**
 * The short name of a model id, or the id itself for one this build has no
 * name for — a run recorded on a model added later still says what it ran on.
 * A context-window suffix the harness appends ("deepseek-v4-pro[1m]") is not
 * part of the model's name.
 */
export function codingModelName(id: string): string {
  const base = id.replace(/\[[^\]]*\]$/, "");
  if (Object.prototype.hasOwnProperty.call(NAMES, base)) return NAMES[base];
  return prettify(base) ?? id;
}

/** What a run (or a team member) carries about the model it ran on. */
export interface RunModelFields {
  /** What the CLI reported answering (its init event) — the truth once known. */
  model?: string | null;
  /** Every model the run's usage was billed to — SORTED by id, not in order, and may include a helper's. */
  modelsUsed?: readonly string[] | null;
  /** What the run was started with. */
  requestedModel?: string | null;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The model id to show for a run: what actually answered — `model`, else from
 * `modelsUsed` the one it was started with if that is among them, else the
 * first of them — and only then what it was started with (`requestedModel`).
 * Null when nothing is known: a model is never invented.
 */
export function runModelId(run: RunModelFields | null | undefined): string | null {
  if (!run) return null;
  const answered = clean(run.model);
  if (answered) return answered;
  const requested = clean(run.requestedModel);
  const used = Array.isArray(run.modelsUsed) ? run.modelsUsed.map(clean).filter((m): m is string => !!m) : [];
  if (used.length > 0) return requested && used.includes(requested) ? requested : used[0];
  return requested;
}

/** The short name to show for a run, or null when nothing is known. */
export function runModelLabel(run: RunModelFields | null | undefined): string | null {
  const id = runModelId(run);
  return id ? codingModelName(id) : null;
}

/**
 * One label for SEVERAL runs (a team): the distinct short names in the order
 * first met, at most `max` of them, then "+N" for the rest ("Opus 5.5 ·
 * Sonnet 5 +1"), and the distinct full ids for a tooltip. Null when none of
 * the runs names a model.
 */
export function modelsLabel(runs: ReadonlyArray<RunModelFields | null | undefined>, max = 2): { label: string; ids: string[] } | null {
  const names: string[] = [];
  const ids: string[] = [];
  for (const run of runs) {
    const id = runModelId(run);
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
    const name = codingModelName(id);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  const shown = names.slice(0, max).join(" · ");
  return { label: names.length > max ? `${shown} +${names.length - max}` : shown, ids };
}

/** Whose model a team's label names first: the ones writing the code. */
const TEAM_ROLE_ORDER: readonly string[] = ["worker", "lead", "planner", "reviewer"];

/**
 * A TEAM's models, for one chip: `modelsLabel` over its members with the
 * workers first, then the lead, the planner and the reviewers — so a team
 * whose planner thinks on Opus and whose workers write on Sonnet reads
 * "Sonnet 5 · Opus 5.5". Null when no member names a model.
 */
export function teamModelsLabel(members: ReadonlyArray<RunModelFields & { role?: string | null }>, max = 2): { label: string; ids: string[] } | null {
  const rank = (role: string | null | undefined) => {
    const i = TEAM_ROLE_ORDER.indexOf(role ?? "");
    return i < 0 ? TEAM_ROLE_ORDER.length : i;
  };
  const ordered = members.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.role) - rank(b.m.role) || a.i - b.i).map(({ m }) => m);
  return modelsLabel(ordered, max);
}

/**
 * A team board's members as `teamModelsLabel` reads them: each cast-list entry
 * (`TeamRunRef.model` — what it started with, brought up to what answered once
 * it settled) with its run record's own answer laid over it when the host
 * holds the record.
 */
export function teamMemberModels(
  team: { runs?: ReadonlyArray<{ id: string; role?: string | null; model?: string | null }> | null },
  runOf: (id: string) => RunModelFields | null | undefined = () => undefined,
): (RunModelFields & { role?: string | null })[] {
  return (team.runs ?? []).map((r) => ({ role: r.role, ...memberModelFields(r, runOf(r.id)) }));
}

/**
 * ONE team member's model fields: its run record's answer (`model`,
 * `modelsUsed`) when the host holds the record, with the cast list's `model`
 * standing in for what it was started with.
 */
export function memberModelFields(cast: { model?: string | null } | null | undefined, run: RunModelFields | null | undefined): RunModelFields {
  return { model: run?.model, modelsUsed: run?.modelsUsed, requestedModel: cast?.model ?? run?.requestedModel };
}
