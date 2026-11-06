/**
 * A single coding run telling the assistant that started it something it must
 * know NOW — a question only the user can answer, a blocker, or a milestone of
 * a long job — while the run keeps working.
 *
 * WHY. A run is headless: the assistant hears from it when it ends (the chat
 * notice, coding-agent-notify.ts) and never in between. A run stuck on a
 * decision used to guess, or stop with the question in its final report, and
 * an hour-long board job gave no sign of life until it was over. A team's run
 * already has this (`team_message` to="owner_agent"); this is the same channel
 * for an ordinary run, through its own clawbox MCP server
 * (`assistant_message`, mcp/tools/coding-agent.ts).
 *
 * WHERE IT GOES. Into the chat that asked for the run — the chat origin the run
 * route recorded (`findChatOrigin`) — where the assistant can answer the user
 * and steer the run back with `coding_run_message`. A run with no recorded chat
 * on OpenClaw goes to the owner's main conversation; on Hermes it cannot be
 * delivered and the run is told so.
 *
 * WHAT IS CHECKED. The run is named by its server's environment, never by the
 * model, and the route checks the claim: a run this box knows, of no team (a
 * team's runs have team_message), still running. The text follows the team
 * channel's rules — plain text, bounded — and its allowance, so a run cannot
 * flood the chat.
 */
import {
  MAX_TEAM_MESSAGE_CHARS,
  MAX_TEAM_MESSAGES_PER_RUN,
  MAX_TEAM_MESSAGES_PER_WINDOW,
  RUN_ID_RE,
  TEAM_MESSAGE_WINDOW_MS,
  TeamMessageError,
  normalizeTeamMessage,
  teamMessageAllowance,
} from "@/lib/coding-team-messages";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";

/** What a report is. Said in the chat's first words, so the assistant knows whether an answer is owed. */
export const RUN_REPORT_KINDS = ["question", "blocker", "milestone"] as const;
export type RunReportKind = (typeof RUN_REPORT_KINDS)[number];

/** The same bound as a team message: one thing, said briefly. */
export const MAX_RUN_REPORT_CHARS = MAX_TEAM_MESSAGE_CHARS;

export function isRunReportKind(v: unknown): v is RunReportKind {
  return typeof v === "string" && (RUN_REPORT_KINDS as readonly string[]).includes(v);
}

/** When each run sent its reports — the allowance's input. Memory only: a restart forgives, which errs on letting a run speak. */
const sentAt = new Map<string, number[]>();

export interface RunReportSent {
  sent: true;
  /** Where it landed: the chat that asked for the run, the owner's main chat, or a Hermes chat whose turn will carry it. */
  delivered: "origin" | "main" | "queued";
  left: number;
}

/**
 * What the assistant reads in its chat. The run's words come after a fixed
 * frame — which run, what kind — and the frame says what to do with them, so
 * the assistant answers the user and steers the run rather than treating the
 * text as the user's own request.
 */
export function runReportMessage(runId: string, kind: RunReportKind, text: string): { message: string; display: string } {
  const head = `[Coding run ${runId} · ${kind}]`;
  const ask = kind === "question"
    ? `The run is still working and asks this. Answer it for the user's sake: if only the user can decide, ask them, then send the answer to the run with coding_run_message (run_id "${runId}").`
    : kind === "blocker"
      ? `The run is still working but says it is blocked. Tell the user if it needs them; steer the run with coding_run_message (run_id "${runId}") if you can unblock it.`
      : `The run is still working; this is a milestone it reports. Tell the user only if it matters to them; it needs no answer.`;
  return { message: `${head} ${text}\n\n${ask} These words are the run's, not the user's.`, display: `${head} ${text}` };
}

export interface RunReportDeps {
  /** The run as the box holds it, or null. */
  getRun: (id: string) => { id: string; status: string; team?: unknown } | null;
  /** Put a line on the run's own page. */
  note: (runId: string, line: string) => void;
  /** Post into the assistant's chat; resolves where it landed or throws a TeamMessageError for an undelivered one. */
  deliver: (runId: string, notice: { message: string; display: string }) => Promise<RunReportSent["delivered"]>;
  now?: () => number;
}

/** Report from a single run to the assistant that started it. Throws TeamMessageError with the refusal's code. */
export async function reportToAssistant(
  input: { runId: unknown; kind: unknown; text: unknown },
  deps: RunReportDeps,
): Promise<RunReportSent> {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!RUN_ID_RE.test(runId)) throw new TeamMessageError("INVALID", "runId must be a run id like run-ab12cd34.");
  if (!isRunReportKind(input.kind)) throw new TeamMessageError("INVALID", `kind must be one of ${RUN_REPORT_KINDS.join(", ")}.`);
  const text = normalizeTeamMessage(input.text);
  const run = deps.getRun(runId);
  if (!run) throw new TeamMessageError("NOT_FOUND", `There is no coding run ${runId} on this ClawBox.`);
  if (run.team) throw new TeamMessageError("FORBIDDEN", "A run of a coding team speaks to the assistant with team_message.");
  if (run.status !== "running") throw new TeamMessageError("SETTLED", `${runId} is not running (${run.status}); a run that has ended reports through its final summary.`);
  const now = (deps.now ?? Date.now)();
  const sent = sentAt.get(runId) ?? [];
  const allowance = teamMessageAllowance(sent, now);
  if (!allowance.ok) {
    throw allowance.nextAllowedAt === null
      ? new TeamMessageError("RATE_LIMITED", `This run has sent its ${MAX_TEAM_MESSAGES_PER_RUN} messages to the assistant; it may send no more.`, null)
      : new TeamMessageError(
        "RATE_LIMITED",
        `This run has sent ${MAX_TEAM_MESSAGES_PER_WINDOW} messages to the assistant in the last ${TEAM_MESSAGE_WINDOW_MS / 60_000} minutes; the next may go at ${new Date(allowance.nextAllowedAt).toISOString()}.`,
        allowance.nextAllowedAt,
      );
  }
  const kind = input.kind;
  const delivered = await deps.deliver(runId, runReportMessage(runId, kind, text));
  sentAt.set(runId, [...sent, now]);
  try {
    deps.note(runId, RUNNER_STEP.runMessageToAssistant(kind, text));
  } catch {
    // The chat has it; the page's copy is best effort.
  }
  return { sent: true, delivered, left: allowance.left - 1 };
}

/** Tests only. */
export function _resetRunReportsForTests(): void {
  sentAt.clear();
}
