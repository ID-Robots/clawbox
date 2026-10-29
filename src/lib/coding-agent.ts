import { cachedWorkflowTelemetry, type WorkflowTelemetry } from "@/lib/coding-workflow-telemetry";
/**
 * The Coding Agent — a headless Claude Code session the assistant delegates
 * coding work to.
 *
 * `scripts/claude-ds` (installed to ~/.local/bin by install.sh) is Claude Code
 * pointed at this box's own ClawBox AI plan. The desktop app used to be nothing
 * more than a terminal typed into that wrapper. This module runs the SAME
 * wrapper non-interactively (`claude-ds -p …`) on behalf of the assistant: the
 * agent hands over a task through the MCP tool, the run works in the
 * background, and the summary comes back when it is done.
 *
 * WHY THE RUNNER LIVES IN THE WEB SERVER, NOT THE MCP PROCESS
 *
 * OpenClaw spawns the ClawBox MCP server lazily per session and reaps it after
 * ten idle minutes; a coding run routinely outlives that. The web server is the
 * one long-lived ClawBox process, it already owns the config store the wrapper
 * reads, and it is where the notices (desktop, Telegram) are sent from. The
 * MCP tools are thin callers of the routes in src/app/setup-api/coding-agent.
 *
 * WHAT A RUN MAY DO — chosen to match the blast radius the agent already has
 * through its own shell tool (`bash` on OpenClaw, Hermes' native terminal on
 * Hermes), not to exceed it:
 *   - `--permission-mode acceptEdits`: file edits inside the working folder are
 *     auto-approved; anything else Claude Code would normally ask about is
 *     silently DENIED in -p mode (it cannot ask), and every denial is counted
 *     and reported, so a task that quietly could not finish is visible as such.
 *   - `--tools` restricts the built-in tool set to files, search and Bash — no
 *     sub-agents, no web tools — and Bash runs only through the allow-list
 *     below: build/test/package tooling and read-only git. `rm -rf`,
 *     `git push`, `curl` and friends are never approved, and the deny-list
 *     names the worst of them explicitly because a deny rule beats an allow.
 *   - The credential folders `src/lib/file-guard.ts` protects are denied to
 *     Claude Code's own Read/Edit/Write as well. That is a guard rail against a
 *     mistake, not a sandbox: a shell can spell a path in ways no pattern list
 *     enumerates, exactly as mcp/README.md says of `bash`.
 *   - The run starts with NO Linux capabilities. `clawbox-setup.service` grants
 *     the web server `CAP_NET_BIND_SERVICE`, `CAP_NET_ADMIN` and `CAP_NET_RAW`
 *     as AMBIENT capabilities so it can manage WiFi and bind port 80, and
 *     ambient capabilities are inherited across execve by design — so without
 *     this a run held `CapAmb=0x3400` while the agent's own shell tool, which
 *     the gateway spawns, held none. Measured on a real box: a run asked for
 *     `python3 -c "…/proc/self/status…"` — an allow-listed interpreter, so no
 *     tool policy applied — and printed the three capabilities back. That is
 *     more power than the bar this feature is held to, so the wrapper is
 *     spawned through `setpriv` with the ambient and inheritable sets emptied
 *     and no-new-privs set. Readiness refuses to start a run when `setpriv` is
 *     missing rather than quietly running with the capabilities.
 *   - `--setting-sources user`: the ClawBox OS checkout's own CLAUDE.md and
 *     .claude/settings must not leak into a run that happens to sit under it
 *     (every code project does — data/code-projects is inside the repo).
 *   - The working folder is a code project by default. Any other folder must
 *     be inside the clawbox home, must not be a protected path, and must not be
 *     the ClawBox OS checkout itself: a prompt-injected "fix the OS" would
 *     otherwise edit the running product in place.
 *
 * The wrapper is spawned by absolute path with an EXPLICIT environment. Two
 * reasons: the web server runs under systemd with no ~/.local/bin on PATH, and
 * its own environment carries the session secret and service tokens, none of
 * which a coding run has any business inheriting.
 *
 * Runs are persisted to data/coding-agent-runs.json so a status question can
 * be answered across MCP restarts, and so a run the web server lost to a
 * restart is reported as failed rather than "still running" forever.
 */

import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { randomBytes } from "crypto";
import { CONFIG_ROOT, DATA_DIR, get as configGet, getAll as configGetAll, set as configSet, setMany as configSetMany } from "@/lib/config-store";
import { ARTIFACT_RUN_ID_RE, artifactsDir, ensureArtifactsDir, pruneArtifacts, removeArtifacts, writeRunReport, type PrunedArtifact } from "@/lib/coding-agent-artifacts";
import {
  type InputRefusalCode,
  type RunInputFile,
  MAX_RUN_INPUTS,
  ensureInputsDirs,
  isInputRefusalCode,
  inputsRoot,
  listRunInputs,
  sharedInputsDir,
  readInputPaths,
  removeRunInputs,
  runInputsDir,
  stageRunInputs,
} from "@/lib/coding-run-inputs";
import {
  type ArchiveReason,
  type HistoryPolicy,
  type HistoryRecord,
  type HistoryRetentionMode,
  type OlderRunEntry,
  CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY,
  CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY,
  HISTORY_EXTENDED_LIMITS,
  HISTORY_LIVE_RUNS_KEPT,
  HISTORY_MIN_FREE_BYTES,
  HISTORY_RETENTION_MODES,
  STANDARD_HISTORY_POLICY,
  archiveIndex,
  archiveRun,
  diskSpace,
  harnessTranscriptState,
  hasOlderRuns,
  historyExportSources,
  historyPolicyFrom,
  historyUsage,
  invalidateUsage,
  isDiskLow,
  type DiskSpace,
  type HarnessTranscriptState,
  type HistoryUsage,
  isHistoryExtendedLimit,
  isHistoryRetentionMode,
  keepHarnessTranscripts,
  keepsOlderRuns,
  olderRunIndex,
  olderRunsCap,
  readModelRole,
  readOlderRunRecord,
  releaseHarnessTranscripts,
  removeOlderRun,
  writeOlderRun,
  type TranscriptPinResult,
} from "@/lib/coding-run-history";
import type { ZipSource } from "@/lib/zip-writer";
import { STATE_FLUSH_MS, STREAM_FLUSH_MS, flushDeadline } from "@/lib/run-flush-cadence";
import {
  type CodingPauseMeter,
  type CodingPauseReason,
  type CodingRunStatus,
  MAX_PAUSE_MESSAGE_CHARS,
  holdsResumableSession,
  isCodingRunStatus,
  isHeld,
  isLive,
  isSettled,
  parsePauseReason,
} from "@/lib/coding-agent-status";
import { parseClawaiAllowanceRefusal } from "@/lib/clawai-allowance";
import {
  HARNESS_FAULT_CONFIG_KEY,
  type HarnessFault,
  classifyHarnessFailure,
  harnessFaultMessage,
  harnessFaultProblem,
  parseHarnessFault,
} from "@/lib/coding-harness-fault";
// The runner writes its fixed lines from this table so the surfaces that draw
// them can recognise each one and say it in the owner's language.
import { RUNNER_STEP } from "@/lib/coding-agent-progress";
import { memAvailableMb } from "@/lib/mem-available";
// Why the runs and the handles on them do not live in module-level `let`: this
// file is compiled twice into the one web-server process. See the store below.
import { processStore } from "@/lib/process-store";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";
import {
  CODING_AGENT_CONNECTED_PROVIDERS_CONFIG_KEY,
  CODING_AGENT_PROVIDER_CONFIG_KEY,
  CODING_PROVIDERS,
  DEFAULT_CODING_PROVIDER,
  codingProviderFrom,
  connectedProvidersFrom,
  defaultModelForProvider,
  isCodingProvider,
  isRecordableModel,
  modelsForProvider,
  resolveRunProvider,
  runsOnCodex,
  DEFAULT_OPENAI_MODEL,
  type CodingProvider,
} from "@/lib/coding-provider";
import { getAnthropicConnection, verifyAnthropicKey, type AnthropicSource } from "@/lib/coding-anthropic";
import {
  buildCodexArgs,
  codexEventActions,
  codexLimitUntil,
  codexRulesText,
  CODEX_API_KEY_ENV,
  CODEX_COMMAND,
  isCodexAuthFailure,
  isCodexLimit,
  type CodexMcpServer,
} from "@/lib/coding-codex";
import {
  clearOpenAILimit,
  codexBinary,
  codexHome,
  ensureCodexHome,
  getOpenAIConnection,
  noteOpenAILimit,
  openAILimitedUntil,
  readOpenAIKey,
  type OpenAISource,
} from "@/lib/coding-openai";
import { DATA_DIR_PUBLIC_SUBTREES, isInside, isProtectedFilePath, PROTECTED_HOME_DIRS } from "@/lib/file-guard";
import { beginRunStart, isProjectBeingRemoved } from "@/lib/coding-project-removal-lock";
import { readClawboxManifest } from "@/lib/clawbox-manifest";
import { registerServerApp } from "@/lib/app-proxy";
import { registerOrStartServerApp } from "@/lib/app-server-start";
import { APP_ID_RE } from "@/lib/code-projects";
import { taskTitle } from "@/lib/task-title";
import { planGateFor, type PlanGate } from "@/lib/paid-plan-gate";
import { CLAWAI_PLAN_TIER_KEY, clawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import {
  deriveAllowRule,
  isAllowRuleRefusal,
  MAX_ALLOW_RULES,
  normalizeAllowRules,
  SOFT_HOME_SUBTREES,
  unlockedSoftPaths,
  validateAllowRule,
  type AllowRuleContext,
  type AllowRuleRefusal,
  type DenialInput,
} from "@/lib/coding-permission-rules";
import { MAX_PROJECT_NAME_LENGTH, projectPath, validateProjectId, webappPath } from "@/lib/code-projects";
import {
  getInjectSecrets,
  isReservedSecretName,
  MAX_SECRETS,
  recordRunSecretsHanded,
  releaseRunSecrets,
  resolveSecretsForRun,
  SECRET_INJECT_CONFIG_KEY,
  SECRET_NAME_RE,
  SECRETS_FILE_NAME,
  withoutExpiredSecrets,
  withoutPastDueSecrets,
  type ResolvedRunSecrets,
} from "@/lib/project-secrets";
import { appendSecretAudit, SECRETS_AUDIT_FILE_NAME } from "@/lib/secrets-audit";
import { forgetRunSecrets, redactForRun, registerRunSecrets } from "@/lib/secret-redact";
import { CLAWBOX_READ_ONLY_TOOLS, RUN_READ_PROFILE } from "@/lib/clawbox-run-read-tools";
import { CLAWBOX_READ_ONLY_ENTRY, resolveRunMcpPlan, type RunMcpPlan } from "@/lib/project-mcp-servers";
import {
  anotherAccountLikely,
  accountsSnapshot,
  activeAccountSnapshot,
  markCredentialProblem,
  markLimited,
  onLimitReset,
  prepareAccount,
  probeAccountCredential,
  readAccounts,
  removeCredentialHandoffs,
  startAnthropicAccounts,
  writeCredentialHandoff,
  type AnthropicCredential,
  type LimitRecorded,
  type PreparedAccount,
  type SwapConsumerOutcome,
} from "@/lib/anthropic-accounts";
import {
  detectAnthropicAccountDisabled,
  detectAnthropicAuthFailure,
  detectAnthropicLimit,
  formatResetClock,
  isUsable,
  limitUntil,
  pickAccount,
  poolHealth,
  type AnthropicLimit,
  type AnthropicLimitKind,
} from "@/lib/anthropic-limit";
import { registerSwapConsumer, type SwapContext } from "@/lib/anthropic-swap";
import { startGatewaySwap } from "@/lib/anthropic-gateway";
import { announceCodingAgent } from "@/lib/coding-agent-notify";
import {
  collectVisualEvidence,
  renderEvidenceSection,
  visualCheckBrief,
  withEvidenceSection,
} from "@/lib/coding-review-visual";
import {
  AUTO_MERGE_RETRY_MS,
  boxHostNames,
  decideAutoMerge,
  decideMerge,
  disableAutoMerge,
  emptyChecks,
  enableAutoMerge,
  isPrFoundBy,
  isPrPending,
  isPrPhase,
  markPullRequestReady,
  mergePullRequest,
  NO_CHECKS_GRACE_MS,
  openPullRequest,
  redactForGitHub,
  updatePullRequestBody,
  // Aliased: this module's own MAX_WAIT_MS is the 120-second status-request
  // limit, a different ceiling for a different wait.
  MAX_WAIT_MS as PR_MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  readAutoMergeFacts,
  readPullRequest,
  runBranchName,
  startRunBranch,
  type PrChecks,
  type PrFoundBy,
  type PrState,
} from "@/lib/coding-pr";
import {
  composePullRequestBody,
  isPrBodyTaskMode,
  prBodyTaskModeFrom,
  pullRequestTitle,
  PR_BODY_TASK_MODES,
  type PrBodyTaskMode,
} from "@/lib/coding-pr-body";
import {
  addRunWorktree,
  commitsAhead,
  deleteRunBranch,
  mergeRunBranch,
  removeRunWorktree,
  restoreRunWorktree,
  sweepRunWorktrees,
  worktreeHasChanges,
  type MergeHomeBlocker,
} from "@/lib/coding-run-worktree";
import { worktreeHintFor, worktreeHintText } from "@/lib/coding-worktree-paths";
import {
  autoMergeOutstanding,
  buildReviewFeedback,
  clampReviewRounds,
  decideReviewFixPath,
  decideReviewRound,
  DEFAULT_REVIEW_ROUNDS,
  describeProblems,
  findOpenPullRequestForBranch,
  isReviewPending,
  MAX_REVIEW_ROUNDS,
  MIN_REVIEW_ROUNDS,
  parseReviewLoop,
  pushBranch,
  readFailedCheckLogs,
  readReviewSnapshot,
  requestCodeRabbitReview,
  REVIEW_MAX_WAIT_MS,
  REVIEW_NO_CHECKS_GRACE_MS,
  reviewPollIntervalMs,
  reviewProblems,
  type ReviewCheck,
  type ReviewLoop,
  type ReviewSnapshot,
} from "@/lib/coding-review";
import {
  completionAttemptsFrom,
  completionNudge,
  gaveUpReason,
  MAX_COMPLETION_ATTEMPTS,
  MAX_MISSING_CHARS,
  MIN_COMPLETION_ATTEMPTS,
  parseAttempts,
  parseDeliverable,
  parseDeliverableVerdict,
  readDeliverableInput,
  type Deliverable,
  type DeliverableVerdict,
  type RunAttempt,
} from "@/lib/coding-deliverable";
import { checkDeliverable, type DeliverableSandbox } from "@/lib/coding-deliverable-check";
import { commitRunWork, lastCommit, type LastCommit, newestCommitSince } from "@/lib/coding-git";
import {
  CODING_AGENT_GIT_EMAIL_CONFIG_KEY,
  CODING_AGENT_GIT_NAME_CONFIG_KEY,
  CODING_GIT_EMAIL_REFUSAL,
  CODING_GIT_NAME_REFUSAL,
  MAX_GIT_IDENTITY_CHARS,
  normalizeCodingGitEmail,
  normalizeCodingGitName,
} from "@/lib/coding-git-identity";
import { readPipelineDefault } from "@/lib/coding-pipeline-store";
import {
  addEvidence,
  clonePipeline,
  decidePipeline,
  enterStage,
  improvementNudge,
  isPipelineLive,
  newPipeline,
  parsePipeline,
  defaultPipelineInput,
  readPipelineInput,
  stageNoun,
  stepFor,
  stopPipeline,
  type PipelineInput,
  type PipelineInputRefusal,
  type PipelineStage,
  type PipelineState,
  type PipelineTransition,
  type PipelineVerify,
  type StageOutcome,
} from "@/lib/coding-pipeline";
import {
  EXPERIENCE_BLOCK_MAX_CHARS,
  EXPERIENCE_RULE_ID,
  readExperienceInput,
  renderExperience,
  type ExperienceInputRefusal,
  type RunExperience,
} from "@/lib/coding-experience";
import { closeSessionsForRun } from "@/lib/browser-sessions";
import { ensureProjectIcon } from "@/lib/project-icon";
import { webappIconPath } from "@/lib/webapp-icon";
import {
  isRunScopeUnit,
  noteScopeRefused,
  noteScopeWorked,
  probeSystemdRun,
  runScopeUnit,
  SCOPE_REFUSED,
  scopeEnv,
  stopUnit,
  unitActive,
  buildScopeArgv,
  RUN_NICE,
} from "@/lib/coding-run-unit";
import { cpuBudgetBrief, hostCpuCount, MAX_CPU_BUDGET, onBatteryPower, RUN_CPU_BUDGET_ENV, runCpuBudget } from "@/lib/coding-run-cpu";
import { LESSON_CHANNEL_BRIEF, readRunNotes, runNotesBlock, settleRunNotes } from "@/lib/coding-run-notes";
import { CONTEXT_CAP_WINDOW, type CodingDiet, DEFAULT_DIET, LEGACY_DIET, looksVisual, mentionsPullRequest, mergeDiet, readDiet, validateDietPatch } from "@/lib/coding-diet";
import {
  applyRoleModelsPatch,
  CODING_AGENT_ROLE_MODELS_CONFIG_KEY,
  MODEL_ROLES,
  modelRoleOf,
  relativeModelCost,
  resolveRoleRun,
  ROLE_AUTO,
  roleModelsFrom,
  roleModelsView,
  type ModelRole,
  type RoleModels,
} from "@/lib/coding-role-models";
import {
  appendRunMessage,
  noteStreamInputRefused,
  noteStreamInputWorked,
  normalizeRunMessage,
  parseRunMessages,
  queuedMessages,
  runMessageProgressLine,
  runMessageTurn,
  runMessagesNote,
  RunMessageError,
  streamInputAvailable,
  streamJsonUserTurn,
  STREAM_INPUT_REFUSED,
  type RunMessage,
  type RunMessageDelivery,
  type RunMessageVia,
} from "@/lib/coding-run-messages";
import { ciFailureLine, ciFixNotes, MAX_CI_FIX_ATTEMPTS, readCiFailure, type CiFailure } from "@/lib/coding-ci";
import {
  clearReceipts,
  ensureRunInbox,
  inboxPending,
  inboxReceipts,
  postToInbox,
  reclaimInbox,
  removeRunInbox,
  runHookScriptPath,
  runHookSettings,
} from "@/lib/coding-run-inbox";

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * config.json key of the owner's switch. Absent means ON (TASK-1639: the box
 * works from chat out of the box, so the main agent can delegate a coding task
 * without the owner opening the app first). Only an explicit `false` — what
 * switching it off writes — is OFF. Runs still work in their own copy on a
 * branch, auto pull requests stay off by default, and the tools are only
 * offered once the harness reports ready.
 */
export const CODING_AGENT_CONFIG_KEY = "coding_agent_enabled";
/**
 * config.json key of the folder a run works in when the caller names neither a
 * project nor a directory. Absent means "no default": a run must then say
 * where it works, as it always had to.
 *
 * It is stored as the owner typed it and re-validated on EVERY use, never
 * trusted because it was validated once when it was set. The containment rules
 * are the same ones an explicit directory faces — a default is a convenience,
 * not a way around them.
 */
export const CODING_AGENT_DIR_CONFIG_KEY = "coding_agent_default_directory";

/**
 * How hard Claude Code thinks per turn. The first five are the levels the
 * installed CLI accepts for `--effort` and the wrapper pins through
 * CLAUDE_DS_EFFORT — it warns and falls back to its default on anything
 * else, so the set is validated here rather than passed through.
 *
 * Higher is slower and costs more; on a Jetson the difference is felt.
 *
 * "ultracode" is not a thinking level but Claude Code's own mode on top of
 * one: xhigh effort plus a standing opt-in to orchestrate the work with its
 * Workflow tool (fan-out, adversarial verification). It was the default until
 * TASK-1749: its fan-outs multiply every run's tokens (an owner measured a job
 * at 20-30 million tokens that a single-agent tool did in ~500k), so the
 * default is now xhigh — the same thinking level without the standing
 * fan-out — and ultracode stays one tap away in the picker.
 * The wrapper requests it with `--effort ultracode` instead of the env pin
 * the fixed levels use, because a pinned CLAUDE_CODE_EFFORT_LEVEL blocks the
 * mode ("clear it and ultracode takes over"). Checked on this box: a -p run
 * under the flag reports "Ultracode is on" and carries the Workflow tool.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
/**
 * The levels the app offers, as opposed to the ones the CLI accepts.
 *
 * Measured on this box, same prompt, deepseek-v4-pro[1m], reasoning tokens:
 *
 *     low 82   medium 94   high 102   xhigh 139   max 414
 *
 * The effort does reach the model — the request carries
 * output_config {"effort": "..."} and it changes with the flag — but low,
 * medium and high land within noise of each other. Offering six buttons
 * where three do the same thing teaches a false model of the machine, so the
 * picker shows the three that measurably differ, plus ultracode. All six stay
 * valid for anyone setting the config key directly.
 */
export const OFFERED_EFFORT_LEVELS: readonly CodingEffort[] = ["low", "xhigh", "max", "ultracode"];
export type CodingEffort = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: CodingEffort = "xhigh";
/** The one level the wrapper cannot pin through the environment — see EFFORT_LEVELS. */
export const ULTRACODE_EFFORT: CodingEffort = "ultracode";
export const CODING_AGENT_EFFORT_CONFIG_KEY = "coding_agent_effort";


/**
 * Full command access and sub-agents are BOTH permanent now, at the owner's
 * instruction. They were switches; the switches are gone.
 *
 * What that settles, so nobody has to rediscover it:
 *
 *   - Every command runs without asking. There is no command policy.
 *   - Claude Code's own Read/Edit/Write tools still refuse the credential
 *     paths, and that is worth keeping because it costs nothing — but it does
 *     NOT hold against Bash. `python3 -c "open('.../config.json').read()"`
 *     reads the file, measured on the box. A tool-name policy cannot fence an
 *     interpreter, so in practice a run can read and write anything the
 *     clawbox user can.
 *   - What still holds: the working folder must resolve inside the ClawBox
 *     home and never the OS checkout, and setpriv still empties the ambient
 *     capability set.
 *
 * Real containment would be an OS boundary — a user that cannot read those
 * files — not a switch.
 */

/**
 * How long a run may go with NO sign of life before the device calls it stuck.
 *
 * This used to be a wall-clock ceiling — twenty minutes from spawn, whatever
 * the run was doing — which quietly made a long project impossible: a build
 * that was working perfectly well was killed mid-flight for the crime of
 * taking a while. Real projects run for hours.
 *
 * So the question is no longer "how long has it been alive" but "is it doing
 * anything". Every stream event stamps lastActivityAt, and only silence
 * counts against a run. Runaway cost is bounded separately and properly, by
 * the owner's step and token ceilings; this is only here so a wedged process cannot
 * hold the one-run-at-a-time slot forever.
 */
export const RUN_IDLE_TIMEOUT_MS = 30 * 60_000;
/** How often the idle check runs. */
const IDLE_CHECK_MS = 60_000;
/** Default agent turns before Claude Code stops itself (`error_max_turns`).
 *  The owner can change it; a long project needs more than a short one.
 *  Raised from 150 to 400 (owner's decision, 2026-09-15): a delivery run that
 *  builds, verifies in the browser and opens a pull request was hitting the
 *  ceiling on ordinary tasks. Lowered to 200 (TASK-1749): measured on
 *  bench/diet 2026-10-18, the longest run of nine specs, a full-stack XL build
 *  included, needed 72 turns; a runaway at 400 turns of ~150k context is ~60M
 *  tokens, and 200 halves that worst case while leaving ~3x headroom. Owners
 *  can raise it (up to MAX_MAX_TURNS). */
export const DEFAULT_MAX_TURNS = 200;

/** A run's tokens by the four ways a provider bills them — see CodingRun.tokenBreakdown. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/** A stored breakdown, leniently: a missing or bad figure is 0. */
export function readTokenBreakdown(raw: unknown): TokenBreakdown {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: n(o.input), output: n(o.output), cacheCreation: n(o.cacheCreation), cacheRead: n(o.cacheRead) };
}

/** How many per-spawn figures a record keeps. */
export const MAX_SPAWN_TOKENS_KEPT = 20;
export const MIN_MAX_TURNS = 10;
export const MAX_MAX_TURNS = 2_000;
export const CODING_AGENT_TURNS_CONFIG_KEY = "coding_agent_max_turns";

/**
 * Optional ceiling on the tokens one run may spend. Null means no ceiling.
 *
 * Claude Code has no flag for this — only --max-budget-usd, which prices an
 * unknown model name and so meant nothing here — so the device enforces it
 * from the usage the stream already reports, and stops the run itself.
 *
 * Counted the way a bill is: every request pays for the input it carries, so
 * input is summed per turn even though the conversation repeats. Cache reads
 * are cheaper than fresh input but are not free, so they count too.
 */
export const CODING_AGENT_TOKENS_CONFIG_KEY = "coding_agent_token_limit";

/**
 * The owner's switch for the automatic review pass: when on, a run that
 * completed AND changed files is followed by ONE more run that resumes the
 * same session and adversarially reviews what was just delivered. Measured
 * on this box: an external judges-then-fix round lifted a delivered project
 * from 6.5 to 9, and a run's own reviewer sub-agent caught a shipped bug —
 * the review pass packages that as a switch. Off by default: it spends the
 * owner's plan on every completed run.
 */
export const CODING_AGENT_REVIEW_CONFIG_KEY = "coding_agent_review_pass";

/**
 * Has the owner been through the setup wizard?
 *
 * The wizard is what collects the consent and the two settings a delegated
 * shell needs, so the app shows it instead of the home page until this is
 * true. Reset clears it, which is the ONLY way back to the wizard — a run
 * failing, or the switch going off, must not restart onboarding.
 */
/**
 * Branch, open a pull request, wait for GitHub Actions, and merge when the
 * checks actually say so.
 *
 * Off by default, and owner-only like every other switch here: it is standing
 * consent for the box to push the agent's work to GitHub and merge it. The
 * guardrails that decide "actually say so" live in @/lib/coding-pr —
 * notably that a pull request with NO checks is never merged, because "every
 * check passed" is trivially true of zero checks.
 */
export const CODING_AGENT_AUTO_PR_CONFIG_KEY = "coding_agent_auto_pr";

/**
 * How much of the run's TASK the pull request the box opens carries:
 * "summary" (the default — a long task is cut to a one-line summary and its
 * first ~600 characters), "full-redacted" or "none". Whatever is chosen is
 * redacted before it is published (src/lib/coding-pr-body.ts and
 * src/lib/publish-redaction.ts, TASK-1366); the run itself always sees its
 * whole task.
 */
export const CODING_AGENT_PR_BODY_TASK_CONFIG_KEY = "coding_agent_pr_body_includes_task";

/**
 * How many REVIEW ROUNDS a pull request gets after it is opened.
 *
 * A round is one follow-up turn handed to the harness — failing check logs,
 * unresolved review comments, "rebase onto <base>" — never merely one poll.
 * The aftermath of a pull request is an hour of work that used to be the
 * owner's; this is how much of it the box does on its own before handing it
 * back.
 *
 * Three by default rather than off, because the loop spends nothing until
 * GitHub actually objects: a pull request that goes green on the first poll
 * costs two `gh` calls and ends. Zero is a real setting and means the loop is
 * off — the pull request is then watched by the older checks-only watcher
 * (`pr.phase === "waiting"`), exactly as it was before this existed.
 */
export const CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY = "coding_agent_review_rounds";

/**
 * May the box MERGE a pull request its own review loop has cleared?
 *
 * OFF by default, and the one switch here that is a consent rather than a
 * preference: everything else the loop does is reversible, and a merge into a
 * shared branch is not. A pull request the loop cleared without this switch
 * ends at `review.state === "clean"` — green, no unresolved comments, open,
 * and the owner presses the button.
 *
 * The same consent covers GitHub's auto-merge: with it on, the loop turns
 * auto-merge on while nothing is outstanding, so the pull request merges the
 * moment its required checks pass rather than on the loop's next poll — or
 * never, once the loop has given up at its ceiling (reconcileAutoMerge).
 *
 * Note the older `coding_agent_auto_pr` watcher merges on green by itself.
 * That is deliberate and unchanged: it is what a box that switched the review
 * loop off has always done, and taking it away would be a behaviour change
 * nobody asked for. The two never run over the same pull request.
 */
export const CODING_AGENT_AUTO_MERGE_CONFIG_KEY = "coding_agent_auto_merge";

/**
 * How many coding runs may be going at once.
 *
 * The box allowed exactly ONE until runs got worktrees, and the two were the
 * same fact: every run worked in the project folder itself, so a second one
 * would have edited the first's half-written files and each settle's
 * `git add -A` would have committed the other's. With a worktree per run
 * (src/lib/coding-run-worktree.ts) that is no longer true, and the limit
 * becomes what it should always have been — a question about the BOX's
 * memory rather than about the filesystem.
 *
 * Two by default. The ceiling scales with the host (`hostMaxParallelRuns`):
 * four on a Jetson or anything under 16 GB of RAM — measured on an 8 GB Orin
 * (2026-09-05) a `claude -p` run with its MCP server is ~270 MB resident two
 * minutes in and grows with its context, and the box is also carrying the web
 * server, the gateway and the desktop's Chromium — and on a bigger host one
 * run per 4 GB, at most sixteen. The ceiling is only what the setting offers;
 * the free-memory guard (`TEAM_SPAWN_MIN_AVAILABLE_MB`) stays the real safety.
 * The automatic review pass does not take one of these slots: it has its own
 * small pool (`REVIEW_PASS_POOL_RUNS`), so a box at its limit still reviews
 * what it delivered and the reviews never crowd out the owner's own runs. A
 * team's runs take these slots like anyone's (`parallelSlotHolders`), within
 * a ceiling of the team's own (MAX_TEAM_WORKERS) and the memory guard, and a
 * team refused one waits for it rather than failing (`teamSpawnSlot`).
 */
export const CODING_AGENT_MAX_PARALLEL_CONFIG_KEY = "coding_agent_max_parallel_runs";
export const DEFAULT_MAX_PARALLEL_RUNS = 2;
export const MIN_MAX_PARALLEL_RUNS = 1;
/** The ceiling on a Jetson or any host under `BIG_HOST_MIN_RAM_GB`. */
export const MAX_MAX_PARALLEL_RUNS = 4;
/** The ceiling on the biggest host, whatever its RAM. */
export const MAX_MAX_PARALLEL_RUNS_BIG_HOST = 16;
export const BIG_HOST_MIN_RAM_GB = 16;
/** RAM a host needs per run before the ceiling grows past four. */
export const RAM_GB_PER_PARALLEL_RUN = 4;
/** Automatic review passes allowed at once, beside the owner's runs. */
export const REVIEW_PASS_POOL_RUNS = 2;

function isJetsonHost(): boolean {
  try {
    return fs.existsSync("/etc/nv_tegra_release");
  } catch {
    return false;
  }
}

/**
 * The most runs at once THIS host may be set to: four on a Jetson or under
 * 16 GB of RAM, otherwise floor(RAM GB / 4), capped at sixteen.
 */
export function hostMaxParallelRuns(
  totalMemBytes: number = os.totalmem(),
  jetson: boolean = isJetsonHost(),
): number {
  const gb = totalMemBytes / 1024 ** 3;
  if (jetson || !Number.isFinite(gb) || gb < BIG_HOST_MIN_RAM_GB) return MAX_MAX_PARALLEL_RUNS;
  return Math.min(
    MAX_MAX_PARALLEL_RUNS_BIG_HOST,
    Math.max(MAX_MAX_PARALLEL_RUNS, Math.floor(gb / RAM_GB_PER_PARALLEL_RUN)),
  );
}

/**
 * The live runs that hold one of the owner's `coding_agent_max_parallel_runs`
 * slots: every one but the automatic review passes, which have their own pool
 * (`REVIEW_PASS_POOL_RUNS`) — a team's runs, any team's, included. ONE count
 * for the ordinary gate and for a team's (`teamSpawnSlot`), so the two never
 * disagree about how full the box is.
 */
function parallelSlotHolders<R extends Pick<CodingRun, "reviewOf">>(live: readonly R[]): R[] {
  return live.filter((r) => !r.reviewOf);
}

/** How many runs at once this box allows, from the raw config value. */
export function maxParallelRunsFrom(raw: unknown, ceiling: number = hostMaxParallelRuns()): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_PARALLEL_RUNS;
  const rounded = Math.round(raw);
  if (rounded < MIN_MAX_PARALLEL_RUNS || rounded > ceiling) return DEFAULT_MAX_PARALLEL_RUNS;
  return rounded;
}

/**
 * How many ATTEMPTS at its deliverable a run gets, the original included.
 *
 * Only ever spent by a run that HAS a deliverable (src/lib/coding-deliverable.ts):
 * one the caller named, or the pull request the auto-PR switch already implies.
 * A run with neither settles exactly as it always did, so this setting costs a
 * box that does not use deliverables nothing at all.
 *
 * One by default (`DEFAULT_COMPLETION_ATTEMPTS`), and the count includes the
 * run's own first turn — so the default buys no resume: check it, tell me,
 * spend nothing more. An owner can raise it to six in all
 * (`MAX_COMPLETION_ATTEMPTS`); each attempt past the first is one resume of
 * the whole session.
 */
export const CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY = "coding_agent_completion_attempts";

export const CODING_AGENT_SETUP_CONFIG_KEY = "coding_agent_setup_complete";

/**
 * May a run draw its own pictures — and may the box draw the project's desktop
 * icon and its favicon while the run works?
 *
 * ON when the key is absent, unlike every other switch here, because this one
 * is not a consent: the icon pipeline already spends the same allowance on a
 * web app the agent creates (src/lib/webapp-icon.ts), and a project that ships
 * with a placeholder glyph is the thing the owner asked to stop seeing. What it
 * costs is bounded twice over — MAX_IMAGES_PER_RUN on the record, and the
 * proxy's own per-UTC-day allowance — so the switch is here for the owner who
 * would rather spend that allowance on the chat.
 */
export const CODING_AGENT_GEN_IMAGES_CONFIG_KEY = "coding_agent_generate_images";

/**
 * May a run have this box SPEAK for it — narration, a greeting, a sound cue —
 * written into its project as a WAV?
 *
 * ON when absent, for the same reason as the pictures. What it costs is
 * different, though, and the brief says so: synthesis is one box-wide slot
 * shared with the chat's spoken replies (withSpeechQueue), and the cloud voice
 * is billed per character.
 */
export const CODING_AGENT_GEN_AUDIO_CONFIG_KEY = "coding_agent_generate_audio";

/**
 * Does a run verify its work in the Chromium on the owner's own SCREEN?
 *
 * /setup-api/browser can drive either of two browsers: the desktop window the
 * owner can watch (attached over CDP on its configured port — 18800 unless the
 * owner pointed it at a browser of their own, src/lib/desktop-browser-config.ts
 * — started if it is not running) or a headless Chromium of the web server's
 * own. The screen is the
 * point — the owner watches the page the run is checking, live, and the run
 * screenshots exactly what they see.
 *
 * ON when the key is absent, like the two media switches and for the same
 * reason: it is a preference, not a consent. The desktop browser is what the
 * device already reaches for, so a box that has never seen this switch must
 * behave exactly as it does today. `false` is for the owner who wants their
 * screen left alone while a run works.
 *
 * Read for EVERY browser session rather than frozen on the run record: unlike
 * the media tools, which must not appear or vanish under a run, this decides
 * only WHICH browser answers — and every answer names it, so a run that asked
 * for the screen and was given the headless one can say so.
 */
export const CODING_AGENT_REAL_BROWSER_CONFIG_KEY = "coding_agent_real_browser";

/**
 * May a coding TEAM's lead change the plan while the team runs — add a task
 * a finished one revealed, retire a pending one the goal no longer needs?
 *
 * OFF when absent: every lead turn is one more paid, read-only run after
 * each worker settles, and a plan that moves under a running team is a
 * different thing from the one the owner saw posted. Read once when a team
 * starts and kept on its board (src/lib/coding-team.ts), so flipping it
 * never changes a team already at work.
 */
export const CODING_TEAM_DYNAMIC_CONFIG_KEY = "coding_team_dynamic";

/**
 * The token diet (src/lib/coding-diet.ts): `{ brief, helpers, visualTools }`,
 * one object. Absent — or any field this build does not offer — reads as
 * DEFAULT_DIET on that knob (lean / lean / auto since TASK-1749's measurement),
 * so a box that never set it gets the lean run. Read at a run's start and frozen on its
 * record (CodingRun.diet), like the effort: the prompt a session was opened
 * with must not change under its resumes.
 */
export const CODING_AGENT_DIET_CONFIG_KEY = "coding_agent_diet";

/**

/**
 * The owner's standing answer to "may a run do this?" — the permission rules
 * every run is started with, on top of the ones the device ships.
 *
 * A LIST and not a switch, because the whole point is that each entry names
 * one thing: `Bash(git log:*)`, `WebFetch(domain:docs.python.org)`. A headless
 * run cannot be asked, so a refused action was refused again on every later
 * run; this is where "Allow next time" on a refusal and the editor in Settings
 * both land.
 *
 * Absent means an EMPTY list — no rule is the safe reading of a box that has
 * never been asked. Every entry is re-validated on the way out
 * (`normalizeAllowRules`), because the floor a rule must clear only ever grows
 * and a rule that was legal under an older build must not reach a run's argv
 * unchecked.
 */
export const CODING_AGENT_ALLOW_RULES_CONFIG_KEY = "coding_agent_allow_rules";

/**
 * The commit identity the box authors the owner's work as — both halves
 * optional, and re-exported here so the settings page, the reset list and the
 * status payload all name the same two keys as the resolver that reads them
 * (src/lib/coding-git-identity.ts).
 */
export {
  CODING_AGENT_GIT_NAME_CONFIG_KEY,
  CODING_AGENT_GIT_EMAIL_CONFIG_KEY,
} from "@/lib/coding-git-identity";

/** Every key the reset clears. The switch is last: it is the consent, and a
 *  half-cleared box that is still switched on would be the one state where the
 *  wizard shows over a live delegated shell. */
export const CODING_AGENT_RESET_KEYS = [
  CODING_AGENT_DIR_CONFIG_KEY,
  CODING_AGENT_EFFORT_CONFIG_KEY,
  CODING_AGENT_TURNS_CONFIG_KEY,
  CODING_AGENT_TOKENS_CONFIG_KEY,
  CODING_AGENT_REVIEW_CONFIG_KEY,
  CODING_AGENT_AUTO_PR_CONFIG_KEY,
  CODING_AGENT_PR_BODY_TASK_CONFIG_KEY,
  CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY,
  CODING_AGENT_AUTO_MERGE_CONFIG_KEY,
  CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY,
  CODING_AGENT_MAX_PARALLEL_CONFIG_KEY,
  // The retention setting goes back to standard; resetCodingAgentSetup also
  // hands Claude Code's transcript period back to whoever set it before.
  CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY,
  CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY,
  CODING_AGENT_GEN_IMAGES_CONFIG_KEY,
  CODING_AGENT_GEN_AUDIO_CONFIG_KEY,
  CODING_AGENT_REAL_BROWSER_CONFIG_KEY,
  CODING_TEAM_DYNAMIC_CONFIG_KEY,
  CODING_AGENT_DIET_CONFIG_KEY,
  CODING_AGENT_ALLOW_RULES_CONFIG_KEY,
  // The commit identity is a SETTING — the owner chose who the box signs their
  // work as — so "start over" puts it back to the project's own git config and
  // the placeholder underneath it.
  CODING_AGENT_GIT_NAME_CONFIG_KEY,
  CODING_AGENT_GIT_EMAIL_CONFIG_KEY,
  // The CONSENT for handing a run the owner's stored secrets, so "start over"
  // withdraws it. The SECRETS themselves are deliberately not cleared — they
  // are credentials the owner pasted, and the same reasoning applies as to the
  // Anthropic key below.
  SECRET_INJECT_CONFIG_KEY,
  // The account a run is paid from is a SETTING, so "start over" puts it back
  // to the box's own plan. Without this a reset left `anthropic` selected, and
  // on a box with no Anthropic credential the wizard it reopened reported the
  // agent as not ready with an Anthropic sentence — over a perfectly connected
  // ClawBox AI plan. The KEY itself is deliberately not here: it is a saved
  // credential, and a reset of the coding agent's settings is not a reason to
  // throw away something the owner pasted (ANTHROPIC_API_KEY_CONFIG_KEY).
  CODING_AGENT_PROVIDER_CONFIG_KEY,
  CODING_AGENT_SETUP_CONFIG_KEY,
  CODING_AGENT_CONFIG_KEY,
] as const;

/**
 * Pictures and clips ONE run may ask this box for.
 *
 * Per RUN and on the record, never per process: finishRun respawns the same
 * record on a transient retry and the review pass resumes the same session, and
 * neither may buy the owner's daily allowance a second time. A model that keeps
 * asking is told how many it has left in every reply, which is what stops the
 * loop before the cap has to.
 */
export const MAX_IMAGES_PER_RUN = 20;
export const MAX_AUDIO_PER_RUN = 40;
export const MIN_TOKEN_LIMIT = 10_000;
/** The longest task a person — the owner, or the assistant on their behalf — may type. */
export const MAX_TASK_CHARS = 4_000;
/**
 * The ceiling on a task the BOX wrote: the automatic review pass, a review-loop
 * round, a deployment-fix turn (see isBoxWrittenTask). MAX_TASK_CHARS is not
 * applied to these.
 *
 * A review round quotes GitHub's failing-check logs and review comments, up to
 * MAX_FEEDBACK_CHARS, and a deployment fix quotes the build log's tail. Held to
 * the typed limit, PR #926's round — four CodeRabbit threads — was refused with
 * "The task is too long" and the pull request handed back unreviewed (TASK-901).
 *
 * Above what any of those builders produces, and CLIPPED to rather than
 * refused at: a box-written task's length is the box's own doing, so it is
 * never the reason a follow-up does not start.
 */
export const MAX_BOX_TASK_CHARS = 32_000;
export const MAX_DIRECTORY_CHARS = 512;

/**
 * A coding TEAM may have several of its runs going at once — its workers in
 * their own git worktrees — up to this many, and only while the box has
 * `TEAM_SPAWN_MIN_AVAILABLE_MB` of MemAvailable to spare for each one after
 * the first. Measured on this Orin Nano (2026-09-05): a `claude -p` run is
 * ~210 MB resident two minutes in with its MCP server at ~60 MB, and grows
 * with its context; the guard is set for three of them beside the web
 * server, the gateway and the desktop's Chromium on a 7.6 GB board.
 *
 * The team SHARES the box: its runs count against the owner's
 * `coding_agent_max_parallel_runs` like any run's, and a run that is not the
 * team's — a single run, the automatic review pass the box starts after one,
 * another team's — is a slot taken, never a reason to fail. Refusing the team
 * outright beside any of them killed it at its first second while single runs
 * went on side by side up to the limit.
 */
export const MAX_TEAM_WORKERS = 3;
export const TEAM_SPAWN_MIN_AVAILABLE_MB = (() => {
  const raw = Number(process.env.CODING_TEAM_MIN_AVAILABLE_MB || 1_200);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1_200;
})();

/**
 * Whether one more run of `team` may start beside the runs already live: the
 * team's own runs under MAX_TEAM_WORKERS, every run's under the owner's limit
 * (`getMaxParallelRuns`, counted as the ordinary gate counts it), and — once
 * anything at all is going on the box — the memory guard. Every refusal is a
 * WAIT: each of them clears as runs settle, so the orchestrator asks again
 * rather than failing the team. The orchestrator asks this before it starts a
 * planner, a worker, a reviewer or a lead; assertCanSpawn asks it again at
 * the spawn, which is the gate.
 *
 * `starting` is how many of the team's workers the orchestrator has
 * dispatched that have not reached their run yet (a worktree is being
 * added): they hold a slot and a share of the memory already, and a count of
 * persisted runs alone would admit a third worker beside two that are
 * seconds from spawning.
 */
export async function teamSpawnSlot(team: RunTeam, starting = 0): Promise<{ ok: true } | { ok: false; reason: string; wait: boolean }> {
  const slot = await judgeTeamSlot(team, starting, false);
  return slot.ok ? { ok: true } : slot;
}

/**
 * teamSpawnSlot's verdict; with `take`, the slot is HELD (`holdSpawnSlot`) in
 * the same synchronous step as the counts it was judged on — the shape the
 * ordinary gate has, for the same reason: a hold taken after this resolved
 * would race every other start that read the same counts meanwhile.
 *
 * The team's own starts are the orchestrator's `starting` or the ones past
 * the gate (`startingTeams`), whichever is more — never the two added, since
 * a worker that is spawning is in both. Everyone else's starts past the gate
 * are the rest of `startingRuns`.
 */
async function judgeTeamSlot(
  team: RunTeam,
  starting: number,
  take: boolean,
): Promise<{ ok: true; release: () => void } | { ok: false; reason: string; wait: true }> {
  const limit = await getMaxParallelRuns();
  // Read only once something is going, and then the counts are read again
  // after it: the verdict and the hold must sit after the LAST await.
  let freeMb: number | null | undefined;
  for (;;) {
    const live = loadRuns().filter((r) => isLive(r.status));
    const atGate = store.startingTeams?.get(team.id) ?? 0;
    const ownStarting = Math.max(0, starting, atGate);
    const othersStarting = Math.max(0, store.startingRuns - atGate);
    const own = live.filter((r) => r.team?.id === team.id).length + ownStarting;
    if (own >= MAX_TEAM_WORKERS) return { ok: false, wait: true, reason: `The team already has ${own} runs going.` };
    const holding = parallelSlotHolders(live).length + othersStarting + ownStarting;
    if (holding >= limit) {
      return { ok: false, wait: true, reason: `This ClawBox is already starting or running ${holding} coding runs at once, which is all it allows; the team waits for a free slot.` };
    }
    const going = live.length + othersStarting + store.startingReviews + ownStarting;
    if (going >= 1 && TEAM_SPAWN_MIN_AVAILABLE_MB > 0) {
      if (freeMb === undefined) {
        freeMb = await memAvailableMb();
        continue;
      }
      // No reading is no evidence of room: a box that cannot say how much
      // memory it has left is not one to start a second run on.
      if (freeMb === null) return { ok: false, wait: true, reason: `Cannot read the box's free memory, so no second run starts beside the ${going} going.` };
      if (freeMb < TEAM_SPAWN_MIN_AVAILABLE_MB) {
        return { ok: false, wait: true, reason: `Not enough free memory for another run beside the ${going} going (${freeMb} MB free, ${TEAM_SPAWN_MIN_AVAILABLE_MB} MB needed).` };
      }
    }
    return { ok: true, release: take ? holdSpawnSlot(false, team.id) : () => {} };
  }
}
/** Longest a status request may block waiting for a run to finish. */
export const MAX_WAIT_MS = 120_000;
/**
 * Runs kept in data/coding-agent-runs.json, newest first — in EVERY history
 * mode. A mode that keeps more keeps the rest as older runs, one file each
 * (src/lib/coding-run-history.ts), because this file is rewritten whole on
 * every flush.
 */
const MAX_RUNS_KEPT = HISTORY_LIVE_RUNS_KEPT;
/**
 * Progress lines kept per run — and how many of them are the run's FIRST.
 *
 * A plain tail dropped a long run's opening silently: a 60-line window over a
 * 109-step run began at "+28m 59s", with "Started with …", the branch it took
 * and its early edits gone and nothing on the record saying so, so every
 * surface drew a partial history as if it were the whole one. The head is now
 * kept as well, with ONE line between the two halves counting what fell out
 * (RUNNER_STEP.dropped) — a step of its own in the feed, because `progress` is
 * all the surfaces are handed.
 *
 * The bound is unchanged: 60 entries per run, whatever the run's length —
 * 20 oldest + the marker + the 39 newest. The file holds up to MAX_RUNS_KEPT
 * records and is rewritten whole on every flush, so its size is the thing
 * being bounded, not the count of steps.
 */
const PROGRESS_KEEP = 60;
const PROGRESS_HEAD_KEEP = 20;
const MAX_PROGRESS_LINE_CHARS = 160;
/**
 * The plan Claude Code keeps through its TodoWrite tool, as much of it as a
 * card can show. Twenty items is more than any run on this box has planned;
 * a longer list is a run enumerating files, not planning, and the newest
 * twenty still say where it is.
 */
const MAX_TODOS = 20;
const MAX_TODO_CHARS = 160;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_ERROR_CHARS = 1_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_STDOUT_LINE_CHARS = 1_000_000;
const STOP_GRACE_MS = 3_000;
/** How often progress is flushed to disk while a run is busy. */
const FLUSH_INTERVAL_MS = STATE_FLUSH_MS;
/**
 * How long a settling run waits for its project picture. The generation itself
 * is allowed two minutes upstream, which is the right budget while a run works
 * and far too long once it has finished: past this the run settles and the
 * picture, if it arrives at all, arrives uncommitted.
 */
const SETTLE_ICON_BUDGET_MS = 20_000;

/**
 * How long a teardown waits for the settle path — see `settleWork`.
 *
 * UNDER vitest's 10 s default hook budget, deliberately: a drain that outlives
 * the hook it runs in fails the suite instead of bounding it.
 */
const SETTLE_DRAIN_BUDGET_MS = 5_000;

/**
 * How long after a killed child is reaped its run may still settle.
 *
 * finishRun runs from the child's `close` handler — or, when a grandchild holds
 * the pipes open, 250 ms after `exit` (see spawnRun). A reaped child is
 * therefore not a finished run, and treating it as one is how a drain returned
 * before the work it exists to wait for had even been registered.
 */
const CHILD_SETTLE_GRACE_MS = 400;

/** How often the drain looks at whether the children it killed are gone. */
const REAP_POLL_MS = 20;

/**
 * Where a run's stream-json output is written, and why it is a FILE and not
 * just a pipe any more.
 *
 * A run lives in its own systemd scope now (coding-run-unit.ts), so it outlives
 * the web server — and a process whose stdout pipe has just been closed by its
 * dead parent dies on the next line it prints. So the harness writes into a log
 * of its own and the web server TAILS it: nothing the run does depends on the
 * reader being there, and a restarted server picks the tail up from the byte it
 * had reached (`CodingRun.streamOffset`) rather than losing the rest of the run.
 *
 * Deliberately not the run's evidence folder: this is the box's own plumbing,
 * not something the owner should find among a run's screenshots, and it is
 * deleted when the run settles.
 */
const STREAM_DIR = path.join(DATA_DIR, "coding-agent-streams");

function streamLogPath(runId: string): string {
  return path.join(STREAM_DIR, `${runId}.jsonl`);
}

function stderrLogPath(runId: string): string {
  return path.join(STREAM_DIR, `${runId}.err`);
}

/**
 * A run's MCP config when its project opted into more than today's server
 * (src/lib/project-mcp-servers.ts): the harness server entries WITH their
 * env and headers, so a FILE — 0600, beside the stream logs — and never argv,
 * which is world-readable in /proc, nor the evidence folder, which the run
 * itself reads through --add-dir. Beside the stream logs because that folder
 * is already denied to every run by name (DATA_SECRET_FILES), so the file
 * adds no entry under data/ for any other run's deny list to discover — and a
 * team's runs are live together. One file per spawn; the settle deletes it
 * (cleanupRunResources), and the boot hook takes what a crash left.
 */
const RUN_MCP_CONFIG_RE = /^(run-[A-Za-z0-9_-]+)\.mcp-[0-9a-f]+\.json$/;

/** Write one spawn's MCP config; answers the path for `--mcp-config`. Synchronous — the spawn is. */
export function writeRunMcpConfig(runId: string, json: string): string {
  // The id itself, not the basename of what it joins to: a separator in it
  // would put the file somewhere the deny list does not name.
  if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) throw new Error("invalid run id for an MCP config");
  fs.mkdirSync(STREAM_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(STREAM_DIR, `${runId}.mcp-${randomBytes(6).toString("hex")}.json`);
  // `wx`: never over the top of something already there.
  fs.writeFileSync(file, json, { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Best effort: a file that will not go is logged, and the next one is still tried. `force` covers only ENOENT. */
function removeRunMcpConfigFile(name: string): void {
  try {
    fs.rmSync(path.join(STREAM_DIR, name), { force: true });
  } catch (err) {
    console.warn(`[coding-agent] could not remove MCP config ${name}:`, err instanceof Error ? err.message : err);
  }
}

/** Remove every MCP config this run's spawns were given. */
export function removeRunMcpConfigs(runId: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(STREAM_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (RUN_MCP_CONFIG_RE.exec(name)?.[1] === runId) removeRunMcpConfigFile(name);
  }
}

/** At boot: every MCP config a server that died left behind. A harness reads its config once, at start, so even a run that is reattached no longer needs its file. */
function sweepRunMcpConfigs(): void {
  let names: string[];
  try {
    names = fs.readdirSync(STREAM_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (RUN_MCP_CONFIG_RE.test(name)) removeRunMcpConfigFile(name);
  }
}

/** How often the tail of a live run's stream log is read. */
const STREAM_POLL_MS = 200;
/** At most this many bytes are read from the log in one go. */
const STREAM_READ_CHUNK = 512 * 1024;
/** How long after the process is gone the log is read one last time. */
const SETTLE_DRAIN_DELAY_MS = 250;
/**
 * How often a REATTACHED run's scope is asked whether it is still there.
 *
 * There is no child object to get an `exit` event from — the process belongs to
 * init now — so the unit is the only thing that can say the run is over.
 */
const UNIT_POLL_MS = 3_000;

/**
 * The run is spawned through this, not directly, so it starts with an empty
 * ambient and inheritable capability set. See the header: the web server holds
 * CAP_NET_ADMIN and CAP_NET_RAW ambiently and every child would otherwise keep
 * them. `--no-new-privs` is here for the same reason — a run has no business
 * regaining through a setuid binary what these flags just took away.
 */
export const CAPABILITY_DROP_COMMAND = "setpriv";
export const CAPABILITY_DROP_ARGS: readonly string[] = [
  "--ambient-caps=-all",
  "--inh-caps=-all",
  "--no-new-privs",
  "--",
];

/** Claude Code tools the run may use at all (`--tools`). No WebFetch/WebSearch:
 *  the appliance is offline-first and the task is local code. The sub-agent
 *  tool is always on (SUBAGENT_DEFINITIONS gives it something to delegate to);
 *  the Workflow tool joins it under ultracode only — see WORKFLOW_TOOL. */
export const CLAUDE_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,NotebookEdit";
/**
 * Claude Code's sub-agent tool, as it appears in `--tools` and in the stream.
 *
 * It is "Agent". This was "Task" — a name the binary also contains — and the
 * mismatch is why every run reported subagentsTotal 0 while the transcripts
 * showed real delegation: the runs WERE handing work to the explorer, and the
 * parser was counting a tool nobody had called. Both names are recognised on
 * the way in so a version that renames it back cannot silence the count
 * again.
 */
export const SUBAGENT_TOOL = "Agent";

/**
 * The sub-agents a run may hand work to.
 *
 * Without these the Task tool exists and is never used: every run on this box
 * reported subagentsTotal 0, because the main model has nothing to delegate
 * TO. Claude Code reads the `description` to decide, which is why each one
 * says "Use proactively" — that phrasing is what actually triggers a hand-off.
 *
 * The model split follows what the two DeepSeek tiers are good at. Flash and
 * Pro share the same 1M window, Flash is roughly three times cheaper, and
 * sub-agents spend most of their tokens READING — files, logs, test output —
 * and hand back a short summary the main model re-checks. So reading and
 * summarising go to Flash, and anything that writes code stays on the main
 * model, where multi-constraint correctness is measurably better.
 *
 * Deliberately no "builder" agent: writing the code is the run's own job, and
 * delegating it would put the expensive judgement behind a summary.
 */
export const SUBAGENT_DEFINITIONS = {
  explorer: {
    description:
      "Searches and maps a codebase: finds where something lives, which files "
      + "matter, how a pattern is used. Use proactively before editing "
      + "unfamiliar code, and whenever a question spans several files.",
    prompt:
      "You map code and report findings. Read and search only — never edit. "
      + "Answer with file paths and line numbers, the shortest excerpt that "
      + "proves the point, and nothing else. Say plainly when you did not find "
      + "something rather than guessing.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
  tester: {
    description:
      "Runs a build, a test suite or a script and reports what failed. Use "
      + "proactively after making changes, to check the work actually holds.",
    prompt:
      "You verify work. Run the build or tests you were asked to run, then "
      + "report ONLY the outcome: pass or fail, the failing cases, and the "
      + "exact error lines. Never edit a file. If a command is refused, say so "
      + "and say which command.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "deepseek-v4-flash",
  },
  reviewer: {
    description:
      "Reads named files and reports real defects — bugs, unsafe handling, "
      + "obvious omissions. Use proactively over changes nothing else will "
      + "review; it never edits.",
    prompt:
      "You review changes already made. Read only — never edit. Report only "
      + "defects you can point at in the code, each with a file, a line and "
      + "what goes wrong. If the change looks correct, say so in one line "
      + "rather than inventing something to say.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
  /**
   * The agent a workflow's `agent()` runs when the script names no agentType.
   * Claude Code's built-in of this name is a full writer on the session's
   * model, and the brief's "every agent() must pass agentType" was ignored on
   * the first ultracode bench run (run-roo5mgvd, 2026-09-03: a four-agent
   * review workflow, all four on the tier model, none typed). A definition of
   * the same name in `--agents` shadows the built-in — measured on this box:
   * the default agent then runs on flash with these tools — so the omission
   * costs flash tokens and can edit nothing, instead of four pro readers.
   */
  "workflow-subagent": {
    description:
      "The agent a workflow runs when its agent() call names no agentType: "
      + "reads, runs checks, reports. Use proactively as a workflow's reader; "
      + "it never edits.",
    prompt:
      "You are one agent of a workflow. Read the files and run the checks you "
      + "were asked to, then report findings with file paths and line numbers, "
      + "or say plainly that you found nothing. Never edit a file.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "deepseek-v4-flash",
  },
  /**
   * The Agent tool's own text says an omitted or unknown subagent_type lands
   * on `general-purpose`, and Claude Code offers `claude` beside it — both
   * full writers on the session's model, under acceptEdits and Bash(*), whose
   * edits never reach filesTouched (a helper's events are dropped) and are
   * still swept into the settle commit. The same shadowing as
   * workflow-subagent, for the two names the brief cannot stop a model from
   * typing.
   */
  // No Bash for either: a fallback is where a MIS-typed call lands, and a
  // shell is a way to write that the parent's changed-files list never
  // sees. A run that wants a check run names the tester.
  "general-purpose": {
    description:
      "A reader for any question the typed helpers do not fit: reads and "
      + "reports with file paths and line numbers. Use proactively for one-off "
      + "questions; it never edits and runs nothing — send the tester to run a check.",
    prompt:
      "You read and report. Read and search only — never edit, never run a "
      + "command. Answer with file paths, line numbers and the shortest "
      + "excerpt that proves the point.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
  claude: {
    description:
      "The same reader under the name the CLI offers by default: reads and "
      + "reports. Use proactively as a plain reader; it never edits and runs nothing.",
    prompt:
      "You read and report. Read and search only — never edit, never run a "
      + "command. Answer with file paths, line numbers and the shortest "
      + "excerpt that proves the point.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
} as const;

export type SubagentName = keyof typeof SUBAGENT_DEFINITIONS;

/**
 * The model a helper runs on, per provider.
 *
 * The definitions above name `deepseek-v4-flash` because that is the cheap
 * tier of the plan they were written for — and it is a model name Anthropic
 * has never heard of. An `anthropic` run with those definitions would have
 * every helper fail on its first call, which is exactly the failure mode
 * this selector must not introduce. `haiku` is Claude Code's own alias for
 * the cheap tier of the account it is signed into, so the split the comment
 * on SUBAGENT_DEFINITIONS describes — readers cheap, writing on the main
 * model — holds on both providers.
 */
export const HELPER_MODEL: Readonly<Record<CodingProvider, string>> = {
  "clawbox-ai": "deepseek-v4-flash",
  anthropic: "haiku",
  // A Codex run is never handed `--agents` (Codex has no such flag); the entry
  // is the provider's economy model so the table stays whole.
  openai: "gpt-5.6-luna",
};

/** The `--agents` payload for a run on this provider. */
export function subagentDefinitionsFor(provider: CodingProvider): Record<string, unknown> {
  const model = HELPER_MODEL[provider] ?? HELPER_MODEL[DEFAULT_CODING_PROVIDER];
  if (model === HELPER_MODEL["clawbox-ai"]) return SUBAGENT_DEFINITIONS;
  return Object.fromEntries(
    Object.entries(SUBAGENT_DEFINITIONS).map(([name, def]) => [name, { ...def, model }]),
  );
}

/**
 * Claude Code's dynamic-workflow tool — the orchestration half of ultracode.
 *
 * Ultracode is xhigh effort plus a standing opt-in to orchestrate the work
 * with this tool, and the CLI's own ultracode reminder tells the model to use
 * it on every substantive task. Until 2026-09-03 a run never had it: `--tools`
 * left it out — and even listed, a headless run cannot use it: the tool asks
 * "Review dynamic workflow before running", and in -p mode that question is
 * answered with a denial. The model gets it as an is_error tool_result,
 * retries the identical call (twice in the probe, two steps gone), and the
 * owner sees only a permission denial on the card. Pre-approved through
 * `--allowedTools Workflow` it works (measured on this box with the installed CLI: a workflow
 * launches in the background, reports task_started / task_progress /
 * task_notification on the stream, and each agent runs on the model its
 * agentType names). So the default effort was quietly half of itself: the
 * thinking, none of the fan-out. The fixed levels never get the tool — there
 * the owner did not opt into orchestration.
 */
export const WORKFLOW_TOOL = "Workflow";

/** The tools of a run that may only read — a team's planner. */
/**
 * The one place outside its folder a run may read: /tmp, where it puts what
 * it curls out of its own server or a build's log. Claude Code asks before
 * reading outside the working folder, and a headless run cannot answer, so
 * the ask became a refusal on the run's page ("Not allowed: Read
 * /tmp/…") for a file the run had written itself. `//` is Claude Code's
 * absolute-path prefix in a permission rule.
 */
export const TMP_READ_RULE = "Read(//tmp/**)";

/**
 * The OTHER place outside its folder a run may read: the inputs tree, where the
 * box stages the assets a run was handed (see @/lib/coding-run-inputs).
 *
 * Read only, and the whole tree rather than this run's folder alone: `shared/`
 * is in it, which is the folder the owner is told to drop files into, and
 * everything under it is there because somebody deliberately put it there. A
 * write needs no rule — the folder is a public data subtree, so no deny rule
 * covers it and `acceptEdits` takes care of the rest.
 *
 * A function and not a constant because DATA_DIR is resolved from the
 * environment, and the suites that build argv point it at a temp folder.
 */
export function inputsReadRule(): string {
  return `Read(/${inputsRoot()}/**)`;
}

export const READ_ONLY_TOOLS = `Read,Grep,Glob,${SUBAGENT_TOOL}`;

export function toolsFor(subagents: boolean, effort?: CodingEffort): string {
  const tools = subagents ? `${CLAUDE_TOOLS},${SUBAGENT_TOOL}` : CLAUDE_TOOLS;
  return effort === ULTRACODE_EFFORT ? `${tools},${WORKFLOW_TOOL}` : tools;
}

/**
 * Bash commands that run without asking. Claude Code's rule syntax: a
 * `Bash(prefix:*)` rule matches any command line starting with that prefix.
 * Build, test and package tooling plus read-only git — the things a coding
 * task needs to prove it worked. Deliberately absent: rm, curl/wget, sudo,
 * systemctl, git push/reset, anything that reaches outside the folder.
 */
export const BASH_ALLOWLIST: readonly string[] = [
  "Bash(npm:*)", "Bash(npx:*)", "Bash(bun:*)", "Bash(bunx:*)", "Bash(node:*)",
  "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(pytest:*)",
  "Bash(tsc:*)", "Bash(eslint:*)", "Bash(prettier:*)", "Bash(make:*)", "Bash(cargo:*)", "Bash(go:*)",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)",
  // Read-only queries a real run asked for and was refused; they change nothing.
  "Bash(git rev-parse:*)", "Bash(git check-ignore:*)", "Bash(git show:*)", "Bash(git branch:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)",
  "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(pwd:*)", "Bash(echo:*)",
];

/**
 * Explicit denials. In -p mode anything outside the allow-list is refused
 * anyway; these exist because a deny rule outranks an allow rule in Claude
 * Code, so no future widening of the allow-list can reach them by accident.
 */
export const BASH_DENYLIST: readonly string[] = [
  "Bash(sudo:*)", "Bash(su:*)", "Bash(rm:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(scp:*)",
  "Bash(systemctl:*)", "Bash(nmcli:*)", "Bash(reboot:*)", "Bash(shutdown:*)",
  "Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)", "Bash(git checkout:*)",
  "Bash(openclaw:*)", "Bash(hermes:*)", "Bash(claude:*)", "Bash(claude-ds:*)", "Bash(clawbox:*)",
];

/**
 * The ONE command deny-list a run is actually started with. Every command is
 * allowed (`Bash(*)`, see buildRunArgs) except killing by NAME and killing
 * every process: the box's own web server is a Next server, and on
 * 2026-09-05 a run's `pkill -f next-server`, meant for the dev server it had
 * started, took ClawBox down with it — systemd restarted the box's server,
 * which marked the run lost fourteen minutes in. A run ends what it started
 * by PID. A deny rule outranks any allow rule in Claude Code, so `Bash(*)`
 * cannot reach these.
 */
export const BASH_KILL_DENYLIST: readonly string[] = [
  "Bash(pkill:*)", "Bash(killall:*)", "Bash(fuser:*)",
  "Bash(kill -1:*)", "Bash(kill -9 -1:*)", "Bash(kill -15 -1:*)", "Bash(kill -TERM -1:*)", "Bash(kill -KILL -1:*)", "Bash(kill -s:*)",
];

/**
 * Folders (relative to the home directory) that hold credential or key
 * material, or this device's own state. NO owner rule may ever open one — the
 * HARD half of the floor a permission rule has to clear.
 *
 * `PROTECTED_HOME_DIRS` is imported rather than restated so the list the Files
 * API guards and the list Claude Code is denied cannot drift. Read entry by
 * entry, every one of them guards a secret: `.ssh` and `.gnupg` are private
 * keys; `.aws`, `.kube`, `.docker` and the three `.config` entries are cloud
 * and registry credentials; `.openclaw`, `.hermes` and `.clawkeep` hold this
 * box's own provider keys, billing token, signing secret and backup
 * passphrase; `.codex` holds an OAuth token. There is no reading of any of
 * them that is merely "outside the working folder", which is why this half
 * takes no exceptions and ships on every single run.
 */
const HARD_HOME_SUBTREES: readonly string[] = PROTECTED_HOME_DIRS;

/**
 * The harness's own state directories — denied wholesale by default, and the
 * ONLY denied subtrees with an allowable part inside them.
 *
 * Each holds two very different things side by side. Directly in the folder:
 * the OAuth credential (`.credentials.json`), the settings, the shell and
 * session history — secrets, judged exactly like the HARD list above and named
 * in `HARNESS_STATE_SECRETS` so they stay denied whatever else opens. And in
 * `projects/<project>/`: the transcripts, plans and memory files a run writes
 * about the folder it is working in. Those hold no credential. They are denied
 * for one reason only — they sit outside the working folder — and that is a
 * refusal an owner should be able to answer.
 *
 * So this is the SOFT half, and the split is a level deeper than the folder:
 * the parent stays shut, one named `projects/<project>` opens. The rule
 * grammar and the names of the openable children live in
 * @/lib/coding-permission-rules (`SOFT_HOME_SUBTREES`), which is pure so the
 * settings panel can judge a rule too; `fileDenyRules` below is what actually
 * leaves a deny rule out of one run's argv.
 */
const HARNESS_STATE_SUBTREES: readonly string[] = [".claude", ".claude-ds"];

/**
 * Everything Claude Code's file tools are denied outside the working folder,
 * hard and soft together. The order is the order the deny rules are built in;
 * nothing reads it for anything else.
 */
const DENIED_HOME_SUBTREES: readonly string[] = [...HARD_HOME_SUBTREES, ...HARNESS_STATE_SUBTREES];

// ─── Types ───────────────────────────────────────────────────────────────────

// The status machine is owned by coding-agent-status.ts (the client and the
// MCP server read it too); re-exported here for the modules that always
// imported it from the runner.
export type { CodingRunStatus };
export type CodingRunSource = "agent" | "owner";

/**
 * One move of a run from an Anthropic account at its limit to the next one in
 * the owner's order. Labels as they read at the time, so the run's page can say
 * what happened without the pool — and without ever holding a credential.
 *
 * `kind` is the limit it hit, or (TASK-1260) `auth` — Anthropic refused the
 * account's credential — or `moved` — the box's active account moved while the
 * run was on one that could no longer answer, because another consumer (a
 * second run, the chat, a cron) hit the limit first.
 */
export interface AccountSwitch {
  at: number;
  fromId: string | null;
  fromLabel: string | null;
  toId: string;
  toLabel: string;
  /** When the account it left is expected back; null when the box had to assume. */
  limitedUntil: number | null;
  kind: AnthropicLimitKind | "auth" | "moved";
}

/** How many switches a record keeps — a night of them, not a history. */
export const MAX_ACCOUNT_SWITCHES = 20;

function normalizeAccountSwitches(raw: unknown): AccountSwitch[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
  return raw.flatMap((entry): AccountSwitch[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const toId = str(e.toId, 16);
    const toLabel = str(e.toLabel, 80);
    if (typeof e.at !== "number" || !toId || !toLabel) return [];
    return [{
      at: e.at,
      fromId: str(e.fromId, 16),
      fromLabel: str(e.fromLabel, 80),
      toId,
      toLabel,
      limitedUntil: typeof e.limitedUntil === "number" ? e.limitedUntil : null,
      kind: e.kind === "weekly" || e.kind === "rate" || e.kind === "credit" || e.kind === "auth" || e.kind === "moved" ? e.kind : "session",
    }];
  }).slice(-MAX_ACCOUNT_SWITCHES);
}

export interface CodingRun {
  /** Short id, e.g. "run-k3x9q2ab". Short on purpose: MCP error text redacts
   *  every 32+ hex run, and a uuid would come out as [REDACTED]. */
  id: string;
  task: string;
  /** Absolute working folder. */
  directory: string;
  projectId: string | null;
  source: CodingRunSource;
  status: CodingRunStatus;
  startedAt: number;
  completedAt: number | null;
  /** Claude Code session id — what `resume_run_id` continues from. */
  sessionId: string | null;
  model: string | null;
  /**
   * Which account paid for this run, frozen at the moment it STARTED — like
   * `effort`, `maxTurns` and the media switches, and for the same reason: a
   * resume must re-enter the session on the credential and the model it was
   * opened with, not on whatever the owner's default has since become.
   */
  provider: CodingProvider;
  /**
   * The model the run was STARTED with — what the caller asked for, which is
   * not `model` above (that is the model the CLI reported once it answered,
   * and on ClawBox AI the plan chooses it). Null where the provider decides.
   */
  requestedModel: string | null;
  /**
   * The role whose provider and model choice this run started under
   * (src/lib/coding-role-models.ts): `planner` for a team's planner and its
   * lead, `bulk` for a worker on a task marked token-heavy. Frozen at start
   * like `provider`. Null for a run that is not a team's, and on a record from
   * before the field.
   */
  modelRole: ModelRole | null;
  /**
   * The Anthropic ACCOUNT — an id in the box's pool (src/lib/anthropic-accounts.ts)
   * — the run's current process is on. Null for a ClawBox AI run and for a
   * record from before the pool. Deliberately NOT frozen the way `provider` is:
   * when an account hits its usage limit the box moves the run to the next one
   * and resumes it in place (TASK-902), and a resume goes to whichever account
   * is first in line at that moment.
   */
  anthropicAccount: string | null;
  /** Every such move, oldest first — what the run's page shows. Bounded. */
  accountSwitches: AccountSwitch[];
  /** The run's final message: what changed, how to verify, what is left. */
  summary: string | null;
  /** Full final result for machine consumers; never parse the clipped display summary. */
  resultText?: string | null;
  /** Actual Workflow children; legacy subagent counters count containers. */
  workflowTelemetry?: WorkflowTelemetry;
  error: string | null;
  numTurns: number;
  filesTouched: string[];
  commandsRun: number;
  /** Set on an automatic review pass: the id of the run it reviews. */
  reviewOf: string | null;
  /**
   * Set on a run a coding TEAM spawned (src/lib/coding-team.ts): which team,
   * in which role, for which task. The board is the audit trail; this is the
   * run's own pointer back to it.
   */
  team: RunTeam | null;
  /**
   * A run that may only read: the team's planner. Its tools are Read, Grep,
   * Glob and the read-only helpers, and no command runs. Frozen at start
   * like the effort, so a retry cannot widen it.
   */
  readOnly: boolean;
  /** Words the team appended to the brief — the planner's or a worker's role. */
  extraBrief: string | null;
  /**
   * How many parallel jobs this run's builds and tests may use
   * (src/lib/coding-run-cpu.ts): worked out at start from the box's CPUs, the
   * runs sharing them and whether it is on battery, then frozen like the
   * effort, so a retry or a completion attempt keeps to the same number. In
   * its environment as CLAWBOX_RUN_CPU_BUDGET and in its brief.
   *
   * Optional in the type so a record built before it existed still
   * type-checks; normalizeRun and newRunRecord always set it (null on an old
   * record, which then gets the lone-run budget at its next spawn).
   */
  cpuBudget?: number | null;
  /**
   * The lessons from the training cluster's experience store this run's system
   * prompt carried (TASK-1348, src/lib/coding-experience.ts): which rules
   * reached it, whether the repository's skill document did, and how long the
   * block was. Null on a run that was given none — every run the dispatcher did
   * not start, and the baseline the cluster's metric compares against.
   *
   * Optional in the type, like `resultText`, so a record built before it
   * existed still type-checks; normalizeRun and newRunRecord always set it.
   */
  experience?: RunExperience | null;
  /**
   * The rendered block itself: what every spawn of this run — a retry, an
   * account switch, a resume — hands the CLI again, and what a run resuming
   * this one inherits. Kept on the box's own record and left out of what the
   * routes answer (cloneRun): `experience` says what it held, and the list it
   * would ride along in is polled every five seconds.
   */
  experienceBrief?: string | null;
  /**
   * The pull request this run's work went into, once the auto-PR switch is on.
   *
   * A FIELD and not a new run status, on purpose. RUN_STATUSES is the persisted
   * allow-list, and readAll() drops any record whose status is not in it before
   * the next writeAll() rewrites the file — so an unrecognised status is a
   * silent DELETE of the run, not a hidden row. A field is forward- and
   * backward-compatible: normalizeRun gives an older record the default below,
   * and an older build ignores a field it does not know.
   */
  pr: PrState | null;
  /**
   * The REVIEW LOOP over that pull request: the rounds of CI failures, review
   * comments and conflicts the box handed back to the harness after the pull
   * request was opened.
   *
   * A field beside `pr` rather than more phases inside it, for the reason `pr`
   * is a field and not a run status: it is forward- and backward-compatible.
   * An older build ignores it, and normalizeRun gives a record that predates it
   * `null` — which reads correctly as "no loop ran over this one".
   */
  review: ReviewLoop | null;
  /**
   * Set on a FOLLOW-UP run the review loop started: the id of the run whose
   * pull request it is fixing.
   *
   * The sibling of `reviewOf`, and it has to be its own field rather than a
   * reuse: `reviewOf` means "this run reviews that one", and the runner reads
   * it to skip the branch, the project icon and a second review pass. A review
   * loop turn needs the same three skips AND one more — its settle must go back
   * to the loop instead of trying to open a pull request the run already has.
   */
  reviewLoopOf: string | null;
  /**
   * Which round of that loop this follow-up run IS, 1-based. Null on every run
   * that is not one.
   *
   * On the run's own record rather than only on the origin's, because the
   * origin carries one counter and a loop has several runs: a fix run's card
   * could say which pull request it belonged to but never which round, so two
   * rounds of the same loop were indistinguishable in the list. The origin's
   * `review.round` stays the loop's counter; this is one run's place in it.
   */
  reviewRound: number | null;
  /**
   * The DELIVERY PIPELINE this run is the build stage of, when it has one.
   *
   * The owner's ask of 2026-09-13: "From prompt -> coding agent -> review ->
   * improvement -> deploy dev -> review -> deploy prod -> review -> task
   * complete. The full run needs to be auto from start to finish." Every one of
   * those stages already existed and each ended on its own; this is the record
   * that joins them up, and it lives on the run that started the whole thing —
   * the review pass and the improvement laps are turns in ITS session, and the
   * deployments are of ITS work.
   *
   * Null on every run that was not asked to go through one, which is the
   * unchanged path: such a run settles exactly as it always did. See
   * src/lib/coding-pipeline.ts for the machine and what each stage means.
   */
  pipeline: PipelineState | null;
  /** Things Claude Code wanted to do and was not allowed to. */
  permissionDenials: number;
  /**
   * WHICH ones, in the owner's words: "Bash: git -C . log --oneline -3".
   *
   * The count alone was not diagnosable — working out what a run had been
   * refused meant reading the progress lines and inferring. This is the
   * owner's own surface, and it holds the same class of text `progress`
   * already does: the command the agent tried, not anything the model wrote
   * about it. Capped, and never sent to Telegram — that notice stays a
   * template.
   */
  deniedActions: string[];
  /**
   * The same refusals, structured — one entry per refused action, self-contained.
   *
   * `deniedActions` is kept rather than replaced: it is what the run rows, an
   * older desktop and the tests already read, and a record written before this
   * field exists still has to render. A reader shows `denials` when it is there
   * and falls back to the strings when it is not, which is why each entry
   * carries its own `text` instead of being paired by index — two lists that
   * must line up by position is exactly the bug a resumed run, which appends to
   * one of them, would introduce.
   *
   * `rule` is the narrowest permission rule that would have allowed the action,
   * or null when there is none to offer: the tool takes no rule, the target
   * could not be read, or — the one that matters — the device refuses that path
   * to EVERY run, so a rule would grant nothing. Computed here, on the server,
   * because only the server knows what `fileDenyRules()` covers.
   */
  denials: CodingDenial[];
  /**
   * How many of the refusals (`permissionDenials`, all of them, not the kept
   * few) were a run in a worktree aiming a file tool at `<project>/<rel>`
   * while `<worktree>/<rel>` was there — answered with a retry hint at the
   * worktree path in the run's transcript (coding-worktree-paths.ts), and
   * marked on its `denials` entry with `worktreePath`. A coding team reads
   * them as soft: a note, not an alert, and never a rejection on their own.
   */
  worktreeHints: number;
  /**
   * The owner's permission rules as they stood when this run STARTED.
   *
   * Frozen on the record for the same reason `effort`, `maxTurns` and `media`
   * are: a retry and the review pass both re-spawn from this record, and the
   * tools a run holds must not appear or vanish under it because the owner
   * edited the list while it was working.
   *
   * `resumeRun` is the single exception, and re-reads the list — a resume is
   * the owner's own deliberate act on a stopped run, and it is what "Allow next
   * time" offers in the same breath as saving a rule. See the comment there.
   */
  allowRules: string[];
  /**
   * The files this run was GIVEN to work from, and the folder they are in.
   *
   * `dir` is answered for every run whether or not anything was staged: it is
   * what the run's page shows the owner as "inputs for this run", and a folder
   * nobody can find is a folder nobody drops a file into. `files` is what the
   * box actually copied there at start (see @/lib/coding-run-inputs); a run may
   * add to the folder itself, which is why the page lists what is on DISK and
   * this list is only the record of the hand-over.
   *
   * `refused` is what the box would NOT copy, by name and with the coded reason
   * (a path outside the folders it may take files from, a file that is not
   * there, one too large). On the record because a caller told only "some
   * inputs were refused" cannot fix the one that was, and because a run that
   * cannot find the picture it was promised must be able to say why.
   *
   * `null` on a record written before this existed — never read as "no inputs",
   * only as "this build cannot say".
   */
  inputs: { dir: string; shared: string; files: RunInputFile[]; refused: { name: string; code: InputRefusalCode }[] } | null;
  /**
   * The NAMES of the owner's secrets this run was handed
   * (src/lib/project-secrets.ts) — never the values, which live in the child's
   * environment and in one in-memory table for the life of the run.
   *
   * On the record because the owner's page has to be able to say what a run was
   * given, and because it is the honest answer to "why did the deploy work for
   * that run and not this one". Safe to put here for the reason the values are
   * not: this file is answered by a route the MCP bearer reaches, and the agent
   * may already list the names (mcp/tools/coding-agent.ts).
   */
  secretNames: string[];
  /** The effort the run was started with. Recorded per-run because the owner
   *  can change the setting while a run is in flight. */
  effort: CodingEffort;
  /** Sub-agents working RIGHT NOW. Always 0 once the run has settled — a
   *  sub-agent cannot outlive the run that spawned it. */
  subagentsActive: number;
  /** WHICH ones, so the app can show what each is doing rather than a count. */
  activeSubagents: ActiveSubagent[];
  /** The helpers that have finished, oldest first, the newest SUBAGENT_HISTORY_KEPT: what each did and how long it took. */
  subagents: FinishedSubagent[];
  /** Sub-agents this run spawned in total, live or finished. */
  subagentsTotal: number;
  /** The commit this run's work was recorded as, when it changed anything. */
  commit: string | null;
  /** How many of each kind — explorer, tester, reviewer. */
  subagentsByType: Record<string, number>;
  /** Every model that did work for this run, main and sub-agents alike. */
  modelsUsed: string[];
  /** The step ceiling this run started with. */
  maxTurns: number;
  /** Tokens spent so far, summed the way a bill is — see the config key. */
  tokensUsed: number;
  /**
   * `tokensUsed` split the way a provider bills it: fresh input, output, and
   * the cached prefix written and read back. Cache reads are most of a long
   * run's total and cost a fraction of fresh input, so a total alone could not
   * be compared with another tool's input/output figures (TASK-1749). Summed
   * over every spawn of this record; a record from before the field reads as
   * all zeros.
   */
  tokenBreakdown: TokenBreakdown;
  /**
   * The tokens each spawn of this record cost, in order: the first is the run
   * itself, every later one a completion attempt, a Fix CI lap or a resume.
   * A review pass is a record of its own (`reviewOf`). Capped at
   * MAX_SPAWN_TOKENS_KEPT, the newest kept.
   */
  spawnTokens: number[];
  /** The ceiling that applied, or null when the run was uncapped. */
  tokenLimit: number | null;
  /**
   * Reasoning tokens Claude Code reports so far.
   *
   * Without this a run on `effort: max` looks identical to a hung one: the
   * first turn of a big task can spend minutes thinking before it emits a
   * single word, and `numTurns` only arrives with the final result event. On
   * a real box that cost a healthy run — the assistant read "0 turns, no
   * progress" and called coding_agent_stop at 295 seconds.
   */
  thinkingTokens: number;
  /**
   * An `openai` run's thread usage as Codex last reported it — its CUMULATIVE
   * figure for the whole thread, not this record's share. Kept so a later
   * spawn that continues the same thread (a resume, a completion attempt) can
   * bill only what it added: see codexUsageBaseline. Absent on every other run.
   */
  codexThreadUsage?: CodexThreadUsage;
  /** When the run last showed ANY sign of life. The answer to "is it stuck?". */
  lastActivityAt: number;
  /**
   * Automatic restarts after a transient upstream failure. At most one, and
   * only for a run that had left nothing behind but inspection output and
   * convergent package-manager setup — see TRANSIENT_FAILURE_RE.
   */
  retries: number;
  /**
   * Whether RESUMING this run's session could help.
   *
   * True only where the session holds real work and merely ran out of room —
   * a turn or cost ceiling. False for a run that died on authentication or
   * transport, because Claude Code persists that failure IN the session and
   * replays it on every resume: observed on a real box, where a transient
   * upstream error at 09:01 was resumed at 09:05 into the same session id and
   * failed identically. A resume is then not a retry, it is a re-enactment.
   */
  resumable: boolean;
  /**
   * WHY this run failed, when the answer is about the DEVICE rather than the
   * task.
   *
   * `error` is a sentence, and a sentence is all a person needs — but a
   * surface that wants to say it in the owner's own language, or to offer the
   * one thing that helps (Settings → AI Models), cannot pattern-match English
   * to find out whether it may. So the verdict is recorded once, here, where
   * it is actually known.
   *
   * `"harness_not_ready"` means the harness could not get a model to answer:
   * see coding-harness-fault.ts for what qualifies and, just as importantly,
   * what does not. Null for every other ending, including every ordinary
   * failure of the work itself, and on a record written before this existed.
   */
  failureKind: "harness_not_ready" | null;
  /**
   * WHY this run is paused — persisted, because the answer outlives the
   * process that knew it.
   *
   * `status: "paused"` alone cannot answer the question the owner actually
   * has. A pause someone asked for needs nothing explained. A pause that
   * followed a refused allowance is the opposite: nobody chose it, and
   * Resume is only the fix once the allowance is back — which is a fact
   * about the far side that the record has to carry, because by the time the
   * owner looks the refusal itself is long gone.
   *
   * Null for a run that was never paused, and for a record written before
   * this field existed. Cleared on resume and on the stop that closes a
   * paused run out, so a stale reason can never describe the pause before
   * last. See CodingPauseReason.
   */
  pauseReason: CodingPauseReason | null;
  progress: string[];
  /** When each progress line was recorded (ms since the epoch), one for one with `progress`. */
  progressAt: number[];
  /**
   * The run's OWN plan — the latest list Claude Code wrote with its TodoWrite
   * tool, whole, replacing the one before it.
   *
   * The progress feed says what tool the run just called; this says what it
   * is trying to do and how far along it is, in its own words. It is the
   * difference between "Read app.js" and "Wiring the game loop — 3 of 7
   * done", and it is what the owner asked to see while a run works. A run
   * that never plans has an empty list, and that is fine: the feed still
   * carries its steps.
   */
  todos: CodingTodo[];
  exitCode: number | null;
  /**
   * The media switches as they stood when this run STARTED, like `effort` and
   * `maxTurns`: the tools a run was given cannot appear or vanish under it
   * because the owner flipped a switch while it worked.
   */
  media: RunMedia;
  /**
   * The owner's review-pass switch as it stood when the run STARTED, frozen
   * like `effort` and `media`: it decides both what the brief says about the
   * reviewer helper (spawnRun) and whether the pass follows (maybeStartReviewPass),
   * and the two must agree — a switch flipped mid-run would otherwise give a
   * run no review at all, or two.
   */
  reviewPass: boolean;
  /**
   * The owner's token diet as it stood when the run STARTED
   * (src/lib/coding-diet.ts), frozen like `effort`: the brief and the tools a
   * session was opened with must not change under its respawns and resumes, or
   * the provider's prefix cache is lost and the run's tools move under it. A
   * record written before the diet existed reads as LEGACY_DIET (full / always
   * / always) — NOT the lean DEFAULT_DIET — so its resumes keep their prompt.
   */
  diet: CodingDiet;
  /**
   * Does this run hold the browser and media tools under `visualTools: "auto"`?
   * Decided ONCE, at the first spawn (`visualTools === "always"`, or
   * `looksVisual` over the task and the folder's top-level entries), and kept
   * for every respawn so the tools and the prompt prefix stay the same. Null
   * until that spawn; a resume inherits a `true` (a run that had the tools
   * keeps them) and decides afresh otherwise.
   */
  visual: boolean | null;
  /** Pictures and clips this run has already been given, against the caps. */
  mediaGenerated: { images: number; audio: number };
  /**
   * The process group this run was spawned into, kept so a leftover server can
   * still be ended after the run itself has settled and `live` has forgotten
   * it. Null for a record that never spawned, or one from before this field.
   */
  pgid: number | null;
  /**
   * The transient systemd scope this run was put in — `clawbox-run-<id>.scope`
   * — or null when the box could not give it one and it is an ordinary child of
   * the web server (see readiness.detachedRuns).
   *
   * The name is what makes a run REATTACHABLE: after a restart it is the only
   * question that can be asked about a process this server never spawned, and
   * the pgid alone cannot answer it — Linux recycles pids, and a stale one would
   * have the Kill button signalling a stranger.
   */
  unit: string | null;
  /**
   * How many bytes of this run's stream log have already been parsed.
   *
   * Persisted with every event, so a restarted server resumes the tail where it
   * left off instead of replaying the run from its first line. The debounced
   * flush means a CRASH can lose the last second of it and a few events may be
   * read twice — duplicated progress lines rather than lost work, which is the
   * safe direction for a fact that only ever moves forward.
   */
  streamOffset: number;
  /**
   * Something the run started is STILL RUNNING now that the run has finished.
   *
   * Not a fault: the orientation guide tells a run to leave a server listening
   * so its app can be reached from the desktop, so a naturally-finished run's
   * process group is deliberately not killed. The owner is told, and the run's
   * page offers to end it — which is the difference between a documented
   * pattern and a leak nobody can see.
   */
  leftover: boolean;
  /** Why the run's work could not be committed at settle — null when it was, or when there was nothing to commit. A team acts on it: a worker whose commit failed has no branch to merge. */
  commitError: string | null;
  /**
   * The run's own copy of the project — a git worktree and a branch of its own
   * (src/lib/coding-run-worktree.ts) — or null when it works in the project
   * folder itself.
   *
   * `directory` is the WORKTREE while this is set; `worktree.project` is the
   * folder the worktree belongs to, and `projectDirectoryOf()` is the one
   * reader of that distinction, so nothing has to know which of the two a run
   * has. Null is the old behaviour exactly: a folder that is not a repository,
   * one that is not its repository's root, a code project inside ClawBox's own
   * checkout, a team's worker (it has a worktree the TEAM made), and every
   * record written before this field existed.
   */
  worktree: RunWorktree | null;
  /**
   * What this run has to LEAVE BEHIND before the box calls it finished.
   *
   * `status: "completed"` used to mean one thing only: Claude Code emitted a
   * success result event. A harness that investigated, concluded the task was
   * beyond it and wrote a paragraph saying so emits exactly that — so the card
   * said "Finished" over a folder with nothing in it. A deliverable is the
   * owner's (or the caller's) answer to "what would prove this run worked",
   * and while one is set, `completed` means the check passed.
   *
   * Null on a run nobody named one for AND on a box with auto-PR off, which is
   * the unchanged path: a run with no deliverable settles exactly as it always
   * has. Frozen at the start like `effort`, `maxTurns` and `media` — the bar a
   * run is held to must not move under it. See src/lib/coding-deliverable.ts.
   */
  deliverable: Deliverable | null;
  /**
   * The last verdict on that deliverable: was it there, and if not what was
   * missing. Null before the first check, and on a run with no deliverable.
   *
   * Kept beside the attempt list rather than folded into it, because this is
   * the CURRENT state of the question — what the card draws — while `attempts`
   * is its history.
   */
  deliverableCheck: DeliverableVerdict | null;
  /**
   * Every attempt at the deliverable, the run's own first turn included.
   *
   * An entry is OPENED when a turn is spawned for this record and CLOSED when
   * the deliverable is judged, so a list of three entries is three harness
   * turns at one task and the reasons each of the first two did not settle it.
   * Empty on a run with no deliverable.
   */
  attempts: RunAttempt[];
  /**
   * The attempt ceiling this run started with, frozen for the reason every
   * other run setting is: the owner changing the number while a run works must
   * not change the promise that run was started under.
   */
  completionAttempts: number;
  /**
   * Things the owner (or the assistant) has told this run while it works, and
   * whether the harness has had each of them yet.
   *
   * A delegated run cannot be asked a question and could not, until now, be
   * told anything either: the only gestures on a live run were Stop and Pause.
   * A queue on the record rather than a pipe in memory, because the answer to
   * "did it get my message?" has to survive the web server restarting — a
   * scoped run outlives it, and its queue must outlive it too.
   *
   * Empty on every record written before this field. See
   * src/lib/coding-run-messages.ts for the bounds and the three ways one is
   * delivered.
   */
  messages: RunMessage[];
  /**
   * The current spawn was given its inbox hook (src/lib/coding-run-inbox.ts):
   * a message sent now reaches it after the tool call it is in. On the record
   * rather than only in memory, because a run reattached after a restart still
   * has its hook and its inbox, and only the record can say so. Absent (false)
   * on a record from before, and for a spawn whose hook script was missing.
   */
  midTurn?: boolean;
  /**
   * A QUEUED run's place in the queue: since when it waits, and what it is
   * started with when its turn comes. Null on every other record. A clone
   * (`cloneRun`) carries the 1-based `position` instead of the request.
   */
  queued?: RunQueueEntry | null;
  /**
   * The pull request's FAILED CI, read when its watcher stopped on failing
   * checks (src/lib/coding-ci.ts): which checks, which tests, which files, the
   * tail of the failed logs. What the run's page and coding_agent_status offer
   * a "Fix CI" continuation from. `attempt` is how many Fix CI continuations
   * led to this run (0 for the one that opened the pull request); `fixRunId`
   * the continuation started from it, once one was. Absent on every other run.
   */
  ci?: RunCi | null;
  /** This run is a "Fix CI" continuation of `runId`, attempt n of MAX_CI_FIX_ATTEMPTS. */
  ciFixOf?: { runId: string; attempt: number } | null;
}

export interface RunCi extends CiFailure {
  attempt: number;
  fixRunId: string | null;
}

/**
 * What a QUEUED run is started with when its turn comes: the caller's own
 * request as the run route took it (`new`), or the owner's Start on a draft
 * (`draft`, which is the record itself). Kept as asked and validated again at
 * the start, by the one reader every start goes through.
 */
export interface QueuedStart {
  kind: "new" | "draft";
  /** A Fix CI continuation — see StartRunInput.fixCi. */
  fixCi?: boolean;
  task?: string;
  projectId?: string | null;
  directory?: string | null;
  resumeRunId?: string | null;
  provider?: unknown;
  model?: unknown;
  deliverable?: unknown;
  pipeline?: unknown;
  inputs?: unknown;
  experience?: unknown;
}

export interface RunQueueEntry {
  /** When it was queued: the order the queue starts runs in. */
  at: number;
  /** Absent from a clone: the request stays on the record. */
  start?: QueuedStart;
  /** 1-based, worked out when a clone is made — never stored. */
  position?: number;
}

/**
 * A run's own copy of the project: where it is, what branch it is on, and
 * where it came from.
 *
 * `project` is the folder the worktree belongs to — the thing every surface
 * means by "the project this run is in" — and it is recorded rather than
 * derived, because the worktree path is only two segments away from it today
 * and a record must not depend on that staying true.
 */
export interface RunWorktree {
  /** Absolute path of the working tree — the same string as `CodingRun.directory`. */
  path: string;
  /** The branch checked out there. */
  branch: string;
  /** The branch it was forked from, and the one a settle merges it back into. */
  base: string;
  /** The project folder the worktree belongs to. */
  project: string;
  /** True once the settle (or the owner) has taken the files away. */
  removed: boolean;
  /**
   * True when the BRANCH went with them — which happens on exactly one path:
   * the run left nothing on it, and an empty `clawbox/<runId>` per run would be
   * litter in the owner's repository.
   *
   * A second flag rather than an inference from `removed`, because the two
   * endings need different things said: a copy removed with its branch kept is
   * "the work is on the branch", and one removed with the branch is "there was
   * no work". Absent on a record written before this field, which reads as
   * "the branch is still there" — the answer for every copy such a record has.
   */
  branchRemoved: boolean;
  /**
   * What became of the run's work: is it IN the project, or only on the
   * branch — and if only on the branch, what stood in the way.
   *
   * The settle merges a run's branch home, and refuses conservatively: the
   * project folder has uncommitted changes of its own, it has been moved to
   * another branch, the merge conflicts. Until this field existed the run
   * still said `completed`, the only control on its card was Remove copy, and
   * the owner's one clue was a progress line. On a box whose owner keeps any
   * uncommitted change in a project folder that is EVERY run — so the state
   * is recorded, the card says it in one sentence with the next step that
   * clears it, and `bringRunWorkHome` re-attempts the merge.
   *
   * Null on a record written before this field, and on the two settles that
   * decided nothing about a merge: a branch with nothing on it (the tree and
   * the branch both go) and a branch a pull request owns (merging would take
   * the commits away from the request they are open as).
   */
  result?: RunWorktreeResult | null;
}

/**
 * Where a run's work ended up.
 *
 * `merged` is the answer the card needs to say WHERE it went — `base` and the
 * merge commit — and `unmerged` the one it needs to say what to do next.
 * `detail` is the device's own English sentence, kept beside the `reason` for
 * the same purpose `code` serves everywhere else here: the card words the
 * reason in the owner's language, and anything without that catalogue (a log,
 * an older surface) still has something true to print.
 */
export interface RunWorktreeResult {
  /** `merged`: the work is in the project. `unmerged`: it is only on the branch. */
  kind: "merged" | "unmerged";
  /** Why the merge did not happen. Null on a merged result. */
  reason: MergeHomeBlocker | null;
  /** The device's own sentence for that reason. Null on a merged result. */
  detail: string | null;
  /** The branch it went into. Null on an unmerged result. */
  base: string | null;
  /** The merge commit. Null on an unmerged result, and when git would not name it. */
  commit: string | null;
}

/** Which media a run may ask this box for — read once, at its start. */
export interface RunMedia {
  images: boolean;
  audio: boolean;
}

/** One item of the run's plan, as Claude Code's TodoWrite tool reports it. */
/** Codex's cumulative token figures for one thread (`turn.completed` usage). */
export interface CodexThreadUsage {
  /** Every input token, the cached prefix included. */
  input: number;
  /** The part of `input` served from the prompt cache. */
  cachedInput: number;
  output: number;
}

export interface CodingTodo {
  content: string;
  status: CodingTodoStatus;
  /** The present-tense form of the item — "Wiring the game loop" — when the
   *  tool sent one. The card shows it as "now" while the item is in progress. */
  activeForm?: string;
}

export type CodingTodoStatus = "pending" | "in_progress" | "completed";
const TODO_STATUSES: readonly CodingTodoStatus[] = ["pending", "in_progress", "completed"];

/** One sub-agent currently out, as the owner should read it. */
export interface ActiveSubagent {
  /** Which definition it is — explorer, tester, reviewer. */
  type: string;
  /** What it was asked to do, in the run's own words. */
  description: string;
  startedAt: number;
}

/** A helper that has come back — or was refused — with when, so the page can say how long it took. */
export interface FinishedSubagent extends ActiveSubagent {
  endedAt: number;
  refused: boolean;
}

/**
 * One refused action, as the owner reads it and as the box can answer it.
 *
 * `text` is what the rail has always shown ("Bash: curl http://example");
 * `rule` is the "Allow next time" button's payload, or null when this box has
 * no rule to offer for it.
 *
 * `refusal` is why there is no rule, and only when there WAS a rule to judge:
 * the action named a path the device keeps every run out of, so the page says
 * so instead of showing a button that could not work. Null covers both "there
 * is a rule" and "this kind of action never had one to offer" (a Bash command,
 * a tool no rule may name) — neither is a refusal the owner can act on.
 */
export interface CodingDenial {
  text: string;
  rule: string | null;
  refusal: AllowRuleRefusal | null;
  /**
   * Where the run meant to go, when it works in a worktree and the refused
   * action aimed at the same path in the project itself (`worktreeHintFor`):
   * the path in its own folder — the one the retry hint named, where the
   * harness could take one. Absent for every other refusal, and on a record
   * from before the hint.
   */
  worktreePath?: string;
  /**
   * The refused action's whole text, when `text` is its first MAX_DENIAL_CHARS
   * only — up to MAX_DENIAL_FULL_CHARS. Never shown: a team judges a refusal by
   * it (`readOnlyDenial`), because a long read-only probe cut at the display
   * length could be anything after the cut. Absent when `text` is the whole of
   * it, and on a record from before it.
   */
  fullText?: string;
}

/** How many finished helpers a run record keeps — the newest; the counts by type keep the total. */
export const SUBAGENT_HISTORY_KEPT = 40;

/** One provider's own half of readiness — its credential, not the box's tools. */
export interface CodingProviderReadiness {
  id: CodingProvider;
  /** Could a run be started against this provider right now? */
  ready: boolean;
  /** The models a caller may name for it; empty where the plan decides. */
  models: readonly string[];
  /** What a run gets when the caller names none. */
  defaultModel: string | null;
  /** Owner-facing sentences, one per missing piece. Empty when ready. */
  problems: string[];
}

export interface CodingHarnessReadiness {
  /**
   * The box AND the owner's DEFAULT provider. This is the field the MCP
   * server's probe reads to decide whether the coding_agent_* tools exist at
   * all, so it has to mean "a run started right now would work" — a box whose
   * default is Anthropic and which has no Anthropic credential is not ready,
   * however healthy its ClawBox AI plan is.
   */
  ready: boolean;
  wrapperInstalled: boolean;
  claudeInstalled: boolean;
  clawaiConnected: boolean;
  /** Has the owner's own Anthropic access — a saved key or a `claude` login? */
  anthropicConnected: boolean;
  /** Which of the two a run would use, or null when there is neither. Never the credential. */
  anthropicSource: AnthropicSource | null;
  /** Is the Codex CLI an `openai` run needs where install.sh puts it? */
  codexInstalled: boolean;
  /** Has the owner's own OpenAI access — a saved key or a ChatGPT sign-in for coding runs? */
  openaiConnected: boolean;
  /** Which of the two an `openai` run would use, or null. Never the credential. */
  openaiSource: OpenAISource | null;
  /**
   * Whether `setpriv` is here to strip the web server's inherited network
   * capabilities off the run. False means no run may start: see the header.
   */
  capabilityDropAvailable: boolean;
  /**
   * Whether the harness has just proved it cannot get a model to answer.
   *
   * False ONLY while a fault recorded by a failed run is still inside its
   * TTL — see coding-harness-fault.ts. Unlike its siblings this is a memory
   * rather than a look at the disk, because the fact it reports (does the
   * plan cover the model the harness asks for?) is upstream's to give and the
   * box only ever learns it by being refused.
   */
  harnessHealthy: boolean;
  /**
   * Whether a run gets its own transient systemd scope, and so SURVIVES a
   * web-server restart (coding-run-unit.ts).
   *
   * Deliberately not in `problems` and deliberately not part of `ready`: a box
   * without it runs exactly as this device always has, and refusing to start a
   * run over it would turn a degradation into an outage. It is reported because
   * the difference is visible to the owner the day an update restarts the
   * server under a run — which is precisely when nobody can find out why.
   */
  detachedRuns: boolean;
  /** Why not, in systemd's own words. Null when runs are detached. */
  detachedRunsDetail: string | null;
  /** Owner-facing sentences, one per missing piece. Empty when ready. */
  problems: string[];
  /**
   * Per provider, so a panel can offer the one that works and say why the
   * other does not — rather than one flat "not ready" that names neither.
   */
  providers: CodingProviderReadiness[];
  /**
   * Could a run be started against ANY provider — not just the default one?
   *
   * A separate fact from `ready`, because the two answer different questions
   * and one field cannot do both. `ready` is "a run started with nothing named
   * would work", which is what a panel shows the owner. This is "the box can
   * run at all", which is what decides whether the coding_agent_* tools exist:
   * a box whose default is an account nobody has connected can still run
   * perfectly well on the other one, and gating registration on `ready` took
   * the tools away from a caller that would have named it.
   */
  anyProviderReady: boolean;
}

/** One role of a coding team as its next fresh run would start: the answer `startRun` gives it. */
export interface TeamRoleModel {
  provider: CodingProvider;
  /** The model on that provider, or null where the provider's plan decides. */
  model: string | null;
  effort: CodingEffort;
  /** Nothing stored chose the provider or the model: the role's default on the team's own provider. */
  auto: boolean;
  /** Could a run be started on that provider right now? The same verdict the spawn gate reaches. */
  ready: boolean;
  /** Why not, in the owner's words — the box's own missing pieces, then the provider's. Empty when ready. */
  problems: string[];
  /** What a token costs on that model, the plan's flash tier = 1 (`relativeModelCost`); null where nobody can say. */
  relativeCost: number | null;
}

/** Every role a choice is made for — see MODEL_ROLES. */
export type TeamRoleModelMap = Record<ModelRole, TeamRoleModel>;

export interface CodingAgentStatus {
  /** The owner's switch. */
  enabled: boolean;
  /**
   * Does this box's ClawBox AI plan pay for the coding agent, and what plan is
   * on record? Owner's decision, 2026-09-14: Pro or Max.
   *
   * REPORTED, never enforced here — `enable` is what refuses, and a box that
   * was already switched on before its subscription lapsed is left alone. This
   * is what lets the settings page say so rather than leaving the owner to
   * discover it at the button.
   */
  planGate: PlanGate;
  /** The owner's default working folder, or null when they have not set one. */
  defaultDirectory: string | null;
  /** What the device proposes when they have not chosen one: ~/Projects. */
  suggestedDirectory: string;
  /** enabled AND the harness is installed and connected — i.e. a run can start. */
  ready: boolean;
  readiness: CodingHarnessReadiness;
  running: number;
  /** The owner's switch for the automatic review pass after a completed run. */
  reviewPass: boolean;
  /** The owner's switch for branch -> pull request -> wait for checks -> merge. */
  autoPr: boolean;
  /** How much of the task that pull request carries, always redacted. */
  prBodyIncludesTask: PrBodyTaskMode;
  /** How many follow-up turns a pull request's review loop gets. 0 = off. */
  reviewRounds: number;
  /** The range the app offers, so it does not have to guess the bounds. */
  minReviewRounds: number;
  maxReviewRounds: number;
  /** May the box merge a pull request its review loop cleared? */
  autoMerge: boolean;
  /** How many coding runs may be going at once — see the config key. */
  maxParallelRuns: number;
  /** The range the app offers, so it does not have to guess the bounds. */
  minMaxParallelRuns: number;
  maxMaxParallelRuns: number;
  /** What the box keeps of finished runs — see src/lib/coding-run-history.ts. */
  historyRetention: HistoryRetentionMode;
  /** The extended mode's N, and the choices the app offers for it. */
  historyLimit: number;
  historyLimits: number[];
  /** Runs the live list holds in every mode (the thirty it always held). */
  historyLiveKept: number;
  /** Attempts a run with a deliverable gets at it, its own first turn included. */
  completionAttempts: number;
  /** The token diet in effect — the stored one, every unset knob at its default. */
  diet: CodingDiet;
  /** The range the app offers, so it does not have to guess the bounds. */
  minCompletionAttempts: number;
  maxCompletionAttempts: number;
  /** May a run draw pictures, and may the box draw the project's icon? */
  generateImages: boolean;
  /** May a run have this box speak a clip into its project? */
  generateAudio: boolean;
  /** Does a run verify its work in the browser on the owner's screen? */
  realBrowser: boolean;
  /** May a coding team's lead add or retire tasks while the team runs? Off unless the owner said so. */
  teamDynamic: boolean;
  /** The owner's standing permission rules, in the order they saved them. */
  allowRules: string[];
  /** How many they may keep, so the editor can say so without guessing. */
  maxAllowRules: number;
  /** May a run be handed the owner's stored secrets? OFF when absent — it is a
   *  consent, not a preference (src/lib/project-secrets.ts). */
  injectSecrets: boolean;
  /**
   * Who the box authors its commits as when the PROJECT has no git identity of
   * its own. Null for either half means "not set" — the resolver then falls
   * through to the placeholder, which is what every box did before this
   * setting existed (src/lib/coding-git-identity.ts).
   */
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  /** How long either half may be, so the fields can say so without guessing. */
  maxGitAuthorChars: number;
  harnessCommand: string;
  maxTaskChars: number;
  /** Which account pays for a run the caller does not name one for. */
  provider: CodingProvider;
  /** The providers this build knows, for the picker. */
  providers: readonly CodingProvider[];
  /** The providers the owner connected to the coding agent (a subset of `providers`, never empty): what a team's roles may be pinned to. */
  connectedProviders: CodingProvider[];
  /** How hard a run thinks per turn. */
  effort: CodingEffort;
  /** The levels the app should show — see OFFERED_EFFORT_LEVELS. */
  effortLevels: readonly CodingEffort[];
  /** A team's per-role provider, model and effort, "auto" for the role's default (src/lib/coding-role-models.ts). */
  roleModels: ReturnType<typeof roleModelsView>;
  /** What each of those roles resolves to right now, whether its provider can run, and what it costs — see TeamRoleModelMap. */
  roleModelMap: TeamRoleModelMap;
  /** Folders in the default project folder the assistant may work in. */
  projectFolders: string[];
  /** The ceilings a run stops at, so the app can show them without guessing. */
  /** Agent steps a run gets, and the range the owner may choose from. */
  maxTurns: number;
  minMaxTurns: number;
  maxMaxTurns: number;
  /** Token ceiling the device enforces, or null for none. */
  tokenLimit: number | null;
  minTokenLimit: number;
  /** Silence, not total time, is what ends a run. */
  runIdleTimeoutMs: number;
  /** False until the owner finishes the setup wizard — the app shows the
   *  wizard instead of the home page while it is. */
  setupComplete: boolean;
}

export interface StartRunInput {
  task: string;
  projectId?: string | null;
  directory?: string | null;
  resumeRunId?: string | null;
  source: CodingRunSource;
  /**
   * Internal: the queue's own start (`startQueuedRun`). The run takes the
   * QUEUED record's id, place and messages, so whoever was told "run-x is
   * queued" goes on following run-x.
   */
  queuedRunId?: string | null;
  /**
   * A "Fix CI" continuation of `resumeRunId`: that run's pull request failed
   * its checks (CodingRun.ci), and the box appends what failed to this task.
   * Refused without a recorded failure, and past MAX_CI_FIX_ATTEMPTS along
   * the chain — never a loop pushing fixes at a red CI for ever.
   */
  fixCi?: boolean;
  /** Internal: set only by the automatic review pass, naming the run under review. */
  reviewOf?: string | null;
  /** Internal: set only by the review loop, naming the run whose pull request
   *  this turn is fixing. See CodingRun.reviewLoopOf. */
  reviewLoopOf?: string | null;
  /** Internal: set only by the review loop, which round this turn is. See
   *  CodingRun.reviewRound. */
  reviewRound?: number | null;
  /**
   * Internal: start a NEW session even though `resumeRunId` names a run.
   *
   * The review loop's fallback, and the only caller. `resumeRunId` carries the
   * chain — the same folder, the same worktree and branch, the same project,
   * provider and model — and normally carries the SESSION with it too. When the
   * session is gone (the run gave up, was stopped, failed in a way a resume
   * replays) the chain is still exactly what a fix run needs; only the memory
   * is not. Without this the start is refused outright and the round is lost.
   *
   * Deliberate rather than inferred: `startRun` already falls back to a fresh
   * session for a run that settled unresumably, and a caller that MEANT to
   * resume must not silently get a cold one — see decideReviewFixPath, which
   * applies the same test so the record cannot claim otherwise.
   */
  freshSession?: boolean;
  /** Internal: set only by a coding team, for its planner and its workers. */
  team?: RunTeam | null;
  /** Internal: a read-only run (the team's planner). */
  readOnly?: boolean;
  /** Internal: appended to the headless brief — the role the team gave this run. */
  extraBrief?: string | null;
  /**
   * Internal: how many runs share the box's CPU budget with this one — a
   * team's workers side by side. The runs live on the box when it starts are
   * counted anyway; this is for the siblings that have not started yet.
   */
  cpuShare?: number | null;
  /**
   * Absolute paths of files this run is to be GIVEN — the pictures the
   * assistant generated for the task, an attachment that arrived in chat.
   *
   * The box copies them into the run's own inputs folder before it spawns,
   * because the assistant writes its media inside a credential store no run may
   * read (see @/lib/coding-run-inputs for why a copy rather than a permission).
   * Unvalidated here on purpose: `readInputPaths` bounds the list and
   * `stageRunInputs` judges each path on its own, answering a coded refusal per
   * entry — a bad path costs that one asset, never the task.
   */
  inputs?: unknown;
  /** Which account pays, when the caller wants something other than the owner's default. */
  provider?: unknown;
  /** Which model, for a provider that lets one be named. Validated together with `provider`. */
  model?: unknown;
  /**
   * What this run has to leave behind before the box calls it finished, as the
   * CALLER sent it — unvalidated. `startRun` reads it through
   * `readDeliverableInput` and throws `invalid` with the reason when it cannot,
   * so a caller learns what this box accepts rather than having its deliverable
   * silently dropped.
   *
   * `source` is what decides whether a `command` deliverable is allowed: the
   * owner holds a browser session, the agent holds the MCP bearer, and a
   * command the box runs on the agent's word would be execution the agent does
   * not otherwise have. See readDeliverableInput.
   */
  deliverable?: unknown;
  /**
   * Whether this run goes through the DELIVERY PIPELINE, as the CALLER sent it
   * — unvalidated, read through `readPipelineInput`, which throws `invalid`
   * with a stable code rather than repairing. `true` is the shorthand for the
   * usual one; an object may name the path to check and what the page must
   * contain, and may switch the production half off.
   *
   * Absent, the project's own default decides (`coding_pipeline_projects`), so
   * a project the owner ships from every day does not need the switch typed
   * into every prompt.
   */
  pipeline?: unknown;
  /**
   * Lessons from earlier verified runs — the training cluster's experience
   * store, as its dispatcher selected it for this task — as the CALLER sent
   * them: unvalidated, read through `readExperienceInput`, which refuses with a
   * stable code rather than repairing. Rendered into the run's system prompt,
   * never into its task. Absent or null, the run starts exactly as it did
   * before the field existed — or, on a resume, carries the block of the run it
   * resumes.
   */
  experience?: unknown;
}

/** A run's place in a coding team. */
export interface RunTeam {
  id: string;
  /** `lead`: the planner back for a moment after a worker settled, deciding whether the plan still fits (read-only, like the planner and the reviewer). */
  role: "planner" | "worker" | "reviewer" | "lead";
  taskId: string | null;
  /**
   * A worker on a task the plan marks token-heavy and not critical — scraping,
   * mass data, repetitive edits, long test runs: it starts on the `bulk`
   * role's provider and model rather than the workers'. Absent for every
   * other run, and read back only when `true`.
   */
  bulk?: boolean;
}

/**
 * `limited` (TASK-902): every Anthropic account in the box's pool is at its
 * usage limit. A refusal like `busy` — 409, CONFLICT to the MCP layer — with
 * the first reset time in its sentence, so a queue waits instead of spending
 * an attempt on a run that would only be refused upstream.
 */
export type CodingAgentErrorKind = "disabled" | "not_ready" | "busy" | "invalid" | "not_found" | "limited";

/**
 * Thrown by startRun/stopRun; the routes map `kind` to a status code.
 * `wait` marks a refusal that clears on its own — a team's run refused for
 * room (its slot count, the memory guard) — so the team's orchestrator waits
 * for it rather than giving up on the run.
 */
export class CodingAgentError extends Error {
  constructor(readonly kind: CodingAgentErrorKind, message: string, readonly wait = false) {
    super(message);
    this.name = "CodingAgentError";
  }
}

/**
 * Refused ONLY because the box is already running every run the owner allows
 * (`coding_agent_max_parallel_runs`): the one refusal the run queue turns into
 * a QUEUED run instead (`startOrQueueRun`). Still a `busy` CodingAgentError for
 * every caller that does not queue — a team's run, the review pass.
 */
export class SlotsFullError extends CodingAgentError {
  constructor(message: string) {
    super("busy", message);
    this.name = "SlotsFullError";
  }
}

/**
 * The HTTP status a route answers a CodingAgentError with — ONE table, so the
 * five routes that catch one cannot disagree. The three refusals are 409:
 * "the request cannot be satisfied as things stand" — the switch is off, the
 * harness is not ready, the slot is taken — which the MCP layer reads as
 * CONFLICT / do-not-retry (403 would read as "the device token was rejected",
 * 500 as "try again").
 */
export function httpStatusForCodingError(kind: CodingAgentErrorKind): number {
  switch (kind) {
    case "invalid": return 400;
    case "not_found": return 404;
    default: return 409;
  }
}

// ─── The owner's switch ──────────────────────────────────────────────────────

export async function isCodingAgentEnabled(): Promise<boolean> {
  return codingAgentEnabledFrom(await configGet(CODING_AGENT_CONFIG_KEY));
}

// Each setting is derived from its raw config value by a pure function, so a
// single read of config.json can answer the whole status (getCodingAgentStatus
// used to open the file eight times per poll) while the one-key getters below
// keep their names.

/** Absent (or anything but an explicit `false`) is ON — see CODING_AGENT_CONFIG_KEY. */
export function codingAgentEnabledFrom(raw: unknown): boolean {
  return raw !== false;
}

function defaultDirectoryFrom(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function effortFrom(raw: unknown): CodingEffort {
  return isEffort(raw) ? raw : DEFAULT_EFFORT;
}

function maxTurnsFrom(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(raw)));
}

function tokenLimitFrom(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_TOKEN_LIMIT ? Math.round(raw) : null;
}

export async function setCodingAgentEnabled(enabled: boolean): Promise<void> {
  await configSet(CODING_AGENT_CONFIG_KEY, enabled === true);
}

/** The owner's default working folder, or null when they have not set one. */
/**
 * The folder this device proposes for a run's work: ~/Projects.
 *
 * It is a SUGGESTION, not a default that silently takes effect — the wizard
 * pre-fills its field with this so the common case is one tap, and the owner
 * can browse to anything else before saving.
 */
export function suggestedDefaultDirectory(): string {
  return path.join(homeDir(), "Projects");
}

/**
 * Create the suggested folder if it is not there yet.
 *
 * A fresh box has no ~/Projects, so a wizard that pre-filled the path would
 * have saved a folder that does not exist and been refused. Called when the
 * owner actually saves a folder inside their own home — never for a path
 * outside it, where creating directories on someone's behalf is not this
 * feature's business.
 *
 * `recursive: true` also makes it a no-op when the folder already exists,
 * which is the usual case.
 */
async function ensureDirectoryInsideHome(directory: string): Promise<void> {
  const home = path.resolve(homeDir());
  const target = path.resolve(directory);
  // The lexical fence, on the very value mkdir is given — a resolved absolute
  // path tested against the home, which is the shape a static analyser
  // recognises as contained. The home itself is out too: it exists, and it is
  // never a working folder (resolveWorkingDirectory refuses it).
  if (!target.startsWith(home + path.sep)) return;
  // The fence that holds on disk: a symlink under the home may lead anywhere
  // (~/scratch → /), the lexical test cannot see it, and mkdir follows it —
  // ~/scratch/Projects would have created /Projects. So the nearest ancestor
  // that exists has to be inside the REAL home as well; what is missing above
  // it cannot be a link, and is what mkdir makes.
  if (!(await existingAncestorInside(target, home))) return;
  try {
    await fs.promises.mkdir(target, { recursive: true });
  } catch {
    // Leave it to resolveWorkingDirectory below to answer "does not exist" in
    // the owner's words; a failure here is not a different fact.
  }
}

/**
 * True when the deepest part of `target` that exists — the path itself, or
 * the nearest ancestor of it — really lies inside `home`, symlinks resolved on
 * both sides. Walks up until realpath answers; the root always does.
 */
async function existingAncestorInside(target: string, home: string): Promise<boolean> {
  const realHome = await fs.promises.realpath(home).catch(() => home);
  let probe = target;
  for (;;) {
    try {
      return isInside(await fs.promises.realpath(probe), realHome);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

export async function getDefaultDirectory(): Promise<string | null> {
  return defaultDirectoryFrom(await configGet(CODING_AGENT_DIR_CONFIG_KEY));
}

/**
 * Set (or clear, with null/"") the default working folder.
 *
 * Validated here rather than only at the route so there is one answer to "is
 * this folder allowed", and it is the same answer a run gets. Returns the
 * resolved path so the owner sees what the device actually recorded — a
 * symlink is stored as the folder it leads to, not as the name they typed.
 */
export async function setDefaultDirectory(directory: string | null): Promise<string | null> {
  if (directory === null || directory.trim() === "") {
    await configSet(CODING_AGENT_DIR_CONFIG_KEY, undefined);
    return null;
  }
  // An absolute path, and only that. The resolver reads a bare name as a
  // folder INSIDE the current default — right when the assistant names a
  // run's folder, wrong for the setting that says where "inside" is: a name
  // typed here was looked for under the previous default and answered "does
  // not exist", and one that happened to exist there quietly moved the
  // default a level down.
  if (!path.isAbsolute(directory.trim())) {
    throw new CodingAgentError("invalid", `Give an absolute path, e.g. ${path.join(homeDir(), "Projects")}.`);
  }
  // Make it real before resolving. The wizard pre-fills ~/Projects, which a
  // fresh box does not have, and "that folder does not exist" is a strange
  // thing to tell someone who just accepted the folder the device proposed.
  // Fenced to the owner's home: outside it, a missing folder is still an error.
  await ensureDirectoryInsideHome(directory.trim());
  const { directory: resolved } = await resolveWorkingDirectory({ directory, asDefault: true });
  await configSet(CODING_AGENT_DIR_CONFIG_KEY, resolved);
  return resolved;
}

/** What `setCodingGitAuthor` stored. A half the caller did not supply is
 *  ABSENT here, not null: it was left exactly as it was. */
export interface CodingGitAuthorSaved {
  name?: string | null;
  email?: string | null;
}

/**
 * Set (or clear, with null/"") the identity the box authors the owner's
 * commits as.
 *
 * ONE setter for both halves, and EVERY supplied half is validated before any
 * of it is written. Two setters called in a row looked equivalent and was not:
 * a body carrying a good name and a bad address stored the name and then
 * answered 400, leaving the owner with half an identity — the state that reads
 * as configured and is not, which is exactly what the resolver's
 * "both halves or neither" rule exists to avoid. `setMany` then lands the pair
 * in one write of the file rather than two.
 *
 * Validated here rather than only at the route for the same reason
 * `setDefaultDirectory` is: there is ONE answer to "is this usable", and it is
 * the resolver's own. A value the settings page accepted but
 * `resolveCodingGitIdentity` would then skip is a setting that reads as saved
 * and does nothing.
 *
 * The e-mail is the half that matters to a deployment check: a host's GitHub
 * integration refuses a deployment whose git author cannot deploy the project,
 * so the address has to belong to an account that can.
 */
export async function setCodingGitAuthor(input: { name?: string | null; email?: string | null }): Promise<CodingGitAuthorSaved> {
  const entries: Record<string, unknown> = {};
  const saved: CodingGitAuthorSaved = {};

  // `!== undefined` rather than `in`: an explicit `undefined` reads as "the
  // caller did not supply this half", which is the safe half of the ambiguity
  // — `null` and `""` are how a half is CLEARED, and those are unmistakable.
  if (input.name !== undefined) {
    const raw = input.name;
    if (raw === null || raw.trim() === "") {
      saved.name = null;
    } else {
      const value = normalizeCodingGitName(raw);
      if (!value) throw new CodingAgentError("invalid", CODING_GIT_NAME_REFUSAL);
      saved.name = value;
    }
    // `undefined` is config-store's documented delete, and setMany honours it
    // inside a batch the same way `set` does on its own.
    entries[CODING_AGENT_GIT_NAME_CONFIG_KEY] = saved.name ?? undefined;
  }

  if (input.email !== undefined) {
    const raw = input.email;
    if (raw === null || raw.trim() === "") {
      saved.email = null;
    } else {
      const value = normalizeCodingGitEmail(raw);
      if (!value) throw new CodingAgentError("invalid", CODING_GIT_EMAIL_REFUSAL);
      saved.email = value;
    }
    entries[CODING_AGENT_GIT_EMAIL_CONFIG_KEY] = saved.email ?? undefined;
  }

  if (Object.keys(entries).length > 0) await configSetMany(entries);
  return saved;
}

function isEffort(value: unknown): value is CodingEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The folder Claude Code keeps its state in for a run on this provider,
 * mirroring scripts/claude-ds exactly. A ClawBox AI run gets
 * CLAUDE_CONFIG_DIR="${CLAUDE_DS_CONFIG_DIR:-$HOME/.claude-ds}". An Anthropic
 * run has CLAUDE_CONFIG_DIR UNSET, so Claude Code falls back to its default,
 * ~/.claude, where the owner's own login lives — and the wrapper sets no
 * override there for this to honour. buildRunEnv hands the run this same HOME
 * and this same CLAUDE_DS_CONFIG_DIR, so the two sides cannot disagree.
 */
export function harnessStateDir(provider: CodingProvider): string {
  if (provider === "anthropic") return path.join(homeDir(), ".claude");
  // An `openai` run is Codex, whose state is the coding agent's own CODEX_HOME
  // under the box's data folder (src/lib/coding-openai.ts) — never ~/.codex.
  if (runsOnCodex(provider)) return codexHome();
  return process.env.CLAUDE_DS_CONFIG_DIR || path.join(homeDir(), ".claude-ds");
}

/**
 * Where Claude Code keeps this run's transcript.
 *
 * It encodes the working folder by replacing every non-ASCII-alphanumeric character with a dash, so
 * /home/clawbox/x becomes -home-clawbox-x. Returns null until the run has a
 * session id, which arrives with the first stream event.
 *
 * The folder is the one the run's OWN provider wrote to — the record's frozen
 * provider, not today's setting, so an old run still resolves after the owner
 * switches. When that file is missing and the other provider's folder has it
 * (a record whose provider was never written, and so reads as the default),
 * the one that exists wins. When neither exists yet, the run's own path is
 * returned: the live preview waits on it, and that is where it will appear.
 *
 * The file exists and grows WHILE the run works, which is what makes a live
 * preview possible rather than only a post-mortem.
 */
export function transcriptPath(run: Pick<CodingRun, "sessionId" | "directory" | "provider">): string | null {
  if (!run.sessionId) return null;
  const provider = codingProviderFrom(run.provider);
  // A Codex run keeps no Claude Code transcript: its session is the CLI's own
  // rollout, and everything the box shows of it came through the stream log.
  if (runsOnCodex(provider)) return null;
  const file = (p: CodingProvider) =>
    path.join(harnessStateDir(p), "projects", run.directory.replace(/[^a-zA-Z0-9]/g, "-"), `${run.sessionId}.jsonl`);
  const own = file(provider);
  if (fs.existsSync(own)) return own;
  const other = file(provider === "anthropic" ? "clawbox-ai" : "anthropic");
  return fs.existsSync(other) ? other : own;
}

/** The owner's effort level. Anything unrecognised reads as the default. */
export async function getEffort(): Promise<CodingEffort> {
  return effortFrom(await configGet(CODING_AGENT_EFFORT_CONFIG_KEY));
}

export async function setEffort(effort: string): Promise<CodingEffort> {
  if (!isEffort(effort)) {
    throw new CodingAgentError("invalid", `Effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
  await configSet(CODING_AGENT_EFFORT_CONFIG_KEY, effort);
  return effort;
}

/** The owner's per-role provider, model and effort choices for a team (src/lib/coding-role-models.ts); {} on a box that never chose. */
export async function getRoleModels(): Promise<RoleModels> {
  return roleModelsFrom(await configGet(CODING_AGENT_ROLE_MODELS_CONFIG_KEY));
}

/**
 * The owner's edit to the per-role choices, checked WHOLE before anything is
 * written — the enable route calls `checkRoleModelsPatch` in its
 * refuse-before-any-write block and this after it.
 */
export async function setRoleModels(patch: unknown): Promise<RoleModels> {
  const next = applyRoleModelsPatch(await getRoleModels(), patch);
  if (!next.ok) throw new CodingAgentError("invalid", next.error);
  await configSet(CODING_AGENT_ROLE_MODELS_CONFIG_KEY, next.value);
  return next.value;
}

/**
 * Why the patch would be refused, or null — the same check `setRoleModels`
 * makes, against the same stored choices, without a write. Against what is
 * stored rather than against nothing: a model named without its provider
 * takes the role's stored one, so the verdict depends on it.
 */
export async function checkRoleModelsPatch(patch: unknown): Promise<string | null> {
  const checked = applyRoleModelsPatch(await getRoleModels(), patch);
  return checked.ok ? null : checked.error;
}

/**
 * What every role of a coding team starts on right now — provider, model,
 * effort — whether that provider can run, and roughly what a token costs
 * there: what the settings draw and what a planner weighs a task's role by.
 *
 * The answer `startRun` gives a team's FRESH run, from the same three inputs
 * (the owner's provider, its default model, the owner's effort) and the same
 * stored choices; a resume keeps what its session was opened on instead.
 * Readiness is the existing probe, read per provider, and `ready` is the
 * verdict the spawn gate reaches for that provider — nothing new is checked.
 */
export async function teamRoleModelMap(): Promise<TeamRoleModelMap> {
  const config = await configGetAll();
  const readiness = await readinessWith(
    config.clawai_token,
    config[HARNESS_FAULT_CONFIG_KEY],
    codingProviderFrom(config[CODING_AGENT_PROVIDER_CONFIG_KEY]),
  );
  return roleModelMapFrom(config, readiness);
}

/** The map off one config snapshot and the readiness already worked out from it — so the status pays for neither twice. */
function roleModelMapFrom(config: Record<string, unknown>, readiness: CodingHarnessReadiness): TeamRoleModelMap {
  const ownerProvider = codingProviderFrom(config[CODING_AGENT_PROVIDER_CONFIG_KEY]);
  const ownerEffort = effortFrom(config[CODING_AGENT_EFFORT_CONFIG_KEY]);
  const stored = roleModelsFrom(config[CODING_AGENT_ROLE_MODELS_CONFIG_KEY]);
  const shared = sharedProblems(readiness);
  const map = {} as TeamRoleModelMap;
  for (const role of MODEL_ROLES) {
    const run = resolveRoleRun(role, ownerProvider, defaultModelForProvider(ownerProvider), ownerEffort, stored);
    const verdict = readiness.providers.find((p) => p.id === run.provider);
    const ready = verdict?.ready === true;
    map[role] = {
      provider: run.provider,
      model: run.model,
      effort: run.effort,
      auto: run.auto,
      ready,
      // The box's own half too: a provider refused because Claude Code is
      // missing must still say why, not show as disabled with no reason.
      problems: ready ? [] : [...shared, ...(verdict?.problems ?? [])],
      relativeCost: relativeModelCost(run.provider, run.model),
    };
  }
  return map;
}

/** The owner's switch for the automatic review pass. Absent means OFF. */
export async function getReviewPass(): Promise<boolean> {
  return (await configGet(CODING_AGENT_REVIEW_CONFIG_KEY)) === true;
}

export async function setReviewPass(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new CodingAgentError("invalid", "The review pass switch must be true or false.");
  await configSet(CODING_AGENT_REVIEW_CONFIG_KEY, on);
  return on;
}

export async function getAutoPr(): Promise<boolean> {
  return (await configGet(CODING_AGENT_AUTO_PR_CONFIG_KEY)) === true;
}

export async function setAutoPr(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The pull-request switch must be true or false.");
  }
  await configSet(CODING_AGENT_AUTO_PR_CONFIG_KEY, on);
  return on;
}

/** How much of the task the box's pull request carries. Absent means "summary". */
export async function getPrBodyIncludesTask(): Promise<PrBodyTaskMode> {
  return prBodyTaskModeFrom(await configGet(CODING_AGENT_PR_BODY_TASK_CONFIG_KEY));
}

export async function setPrBodyIncludesTask(mode: unknown): Promise<PrBodyTaskMode> {
  if (!isPrBodyTaskMode(mode)) {
    throw new CodingAgentError("invalid", `What a pull request includes of the task must be one of: ${PR_BODY_TASK_MODES.join(", ")}.`);
  }
  await configSet(CODING_AGENT_PR_BODY_TASK_CONFIG_KEY, mode);
  return mode;
}

/** How many review rounds a pull request gets. Absent means the default. */
export async function getReviewRounds(): Promise<number> {
  const stored = await configGet(CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY);
  return typeof stored === "number" ? clampReviewRounds(stored) : DEFAULT_REVIEW_ROUNDS;
}

export async function setReviewRounds(rounds: unknown): Promise<number> {
  // Integer, not merely finite: `clampReviewRounds` rounds, so 1.5 would have
  // been SAVED as 2 — an answer to a question the caller did not ask, and the
  // same reason the range below is refused rather than clamped.
  if (typeof rounds !== "number" || !Number.isInteger(rounds)) {
    throw new CodingAgentError("invalid", "The number of review rounds must be a whole number.");
  }
  if (rounds < MIN_REVIEW_ROUNDS || rounds > MAX_REVIEW_ROUNDS) {
    // Refused rather than clamped: a caller that asked for 20 rounds meant
    // something this box does not offer, and silently saving 6 would answer a
    // question it did not ask.
    throw new CodingAgentError("invalid", `The number of review rounds must be between ${MIN_REVIEW_ROUNDS} and ${MAX_REVIEW_ROUNDS}.`);
  }
  const saved = clampReviewRounds(rounds);
  await configSet(CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY, saved);
  return saved;
}

/** How many runs at once this box allows. Absent means the default. */
export async function getMaxParallelRuns(): Promise<number> {
  return maxParallelRunsFrom(await configGet(CODING_AGENT_MAX_PARALLEL_CONFIG_KEY));
}

export async function setMaxParallelRuns(runs: unknown): Promise<number> {
  if (typeof runs !== "number" || !Number.isInteger(runs)) {
    throw new CodingAgentError("invalid", "The number of runs at once must be a whole number.");
  }
  const ceiling = hostMaxParallelRuns();
  if (runs < MIN_MAX_PARALLEL_RUNS || runs > ceiling) {
    // Refused rather than clamped, like the review rounds and the attempts: a
    // caller that asked for more meant something this box does not offer.
    throw new CodingAgentError("invalid", `The number of runs at once must be between ${MIN_MAX_PARALLEL_RUNS} and ${ceiling}.`);
  }
  await configSet(CODING_AGENT_MAX_PARALLEL_CONFIG_KEY, runs);
  // A higher limit is room the queue may take at once.
  void pumpRunQueue();
  return runs;
}

export { CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY, CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY, HISTORY_EXTENDED_LIMITS, HISTORY_RETENTION_MODES };
export type { HistoryPolicy, HistoryRetentionMode };

/**
 * Remember the owner's history setting where the SYNC paths can see it: the
 * settle decides whether a run's stream log is kept for the archive, and it
 * cannot await a config read. Refreshed by every read below and by the status
 * the app polls; empty only in a process that has read neither, where the
 * settle does what it always did.
 */
function rememberHistoryPolicy(policy: HistoryPolicy): HistoryPolicy {
  store.historyPolicy = policy;
  return policy;
}

/** What the box keeps of finished runs. Absent means standard — see coding-run-history.ts. */
export async function getHistoryPolicy(): Promise<HistoryPolicy> {
  const [mode, limit] = await Promise.all([
    configGet(CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY),
    configGet(CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY),
  ]);
  return rememberHistoryPolicy(historyPolicyFrom(mode, limit));
}

/**
 * The Claude Code settings files whose transcripts a run leaves behind: the
 * box's own harness folder (ClawBox AI runs) and the default one an Anthropic
 * run uses — harnessStateDir, both ways. One file when both are the same.
 */
export function harnessSettingsFiles(): string[] {
  return [...new Set((["clawbox-ai", "anthropic"] as const).map((p) => path.join(harnessStateDir(p), "settings.json")))];
}

export interface HistoryRetentionChange {
  policy: HistoryPolicy;
  /** What happened to Claude Code's transcript period, file by file. */
  transcripts: TranscriptPinResult[];
}

/**
 * Change what the box keeps. Either half may be given; a value this box does
 * not offer is refused rather than clamped, like the other counted settings.
 *
 * Nothing is deleted HERE: a lower limit is applied the next time a run joins
 * the list (insertRun), so a mis-tap on the select can be taken back before
 * it costs anything, and the settings card says what the next run will drop.
 * Claude Code's transcript period follows the mode now, though: kept while the
 * owner keeps everything, handed back to what it was as soon as they do not.
 */
export async function setHistoryRetention(input: { mode?: unknown; limit?: unknown }): Promise<HistoryRetentionChange> {
  if (input.mode !== undefined && !isHistoryRetentionMode(input.mode)) {
    throw new CodingAgentError("invalid", `The run history setting must be one of: ${HISTORY_RETENTION_MODES.join(", ")}.`);
  }
  if (input.limit !== undefined && !isHistoryExtendedLimit(input.limit)) {
    throw new CodingAgentError("invalid", `The number of runs to keep must be one of: ${HISTORY_EXTENDED_LIMITS.join(", ")}.`);
  }
  const entries: Record<string, unknown> = {};
  if (input.mode !== undefined) entries[CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY] = input.mode;
  if (input.limit !== undefined) entries[CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY] = input.limit;
  if (Object.keys(entries).length > 0) await configSetMany(entries);
  const policy = await getHistoryPolicy();
  const transcripts = policy.mode === "everything"
    ? await keepHarnessTranscripts(harnessSettingsFiles())
    : await releaseHarnessTranscripts();
  return { policy, transcripts };
}

/** The owner's merge switch. Absent means OFF — see the config key. */
export async function getAutoMerge(): Promise<boolean> {
  return (await configGet(CODING_AGENT_AUTO_MERGE_CONFIG_KEY)) === true;
}

export async function setAutoMerge(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The merge switch must be true or false.");
  }
  await configSet(CODING_AGENT_AUTO_MERGE_CONFIG_KEY, on);
  return on;
}

/** The owner's token diet, every knob it does not name at DEFAULT_DIET's (lean) value. */
export async function getDiet(): Promise<CodingDiet> {
  return readDiet(await configGet(CODING_AGENT_DIET_CONFIG_KEY), DEFAULT_DIET);
}

/**
 * Merge a partial diet over the stored one. The patch is refused WHOLE — an
 * unknown key or a value this build does not offer — before anything is
 * written, with the refusal's stable code in the message's place for the route.
 */
export async function setDiet(patch: unknown): Promise<CodingDiet> {
  const checked = validateDietPatch(patch);
  if (!checked.ok) throw new CodingAgentError("invalid", checked.error);
  const next = mergeDiet(await configGet(CODING_AGENT_DIET_CONFIG_KEY), checked.patch);
  await configSet(CODING_AGENT_DIET_CONFIG_KEY, next);
  return next;
}

/** How many attempts at its deliverable a run gets. Absent means the default. */
export async function getCompletionAttempts(): Promise<number> {
  return completionAttemptsFrom(await configGet(CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY));
}

export async function setCompletionAttempts(attempts: unknown): Promise<number> {
  // Whole numbers only, and the range refused rather than clamped — the rule
  // `setReviewRounds` follows, for its reason: a caller that asked for 20
  // attempts meant something this box does not offer, and quietly saving 6
  // answers a question it did not ask.
  if (typeof attempts !== "number" || !Number.isInteger(attempts)) {
    throw new CodingAgentError("invalid", "The number of attempts must be a whole number.");
  }
  if (attempts < MIN_COMPLETION_ATTEMPTS || attempts > MAX_COMPLETION_ATTEMPTS) {
    throw new CodingAgentError("invalid", `The number of attempts must be between ${MIN_COMPLETION_ATTEMPTS} and ${MAX_COMPLETION_ATTEMPTS}.`);
  }
  await configSet(CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY, attempts);
  return attempts;
}

/** The two media switches. ON when absent — see their config keys. */
function generateImagesFrom(raw: unknown): boolean {
  return raw !== false;
}

function generateAudioFrom(raw: unknown): boolean {
  return raw !== false;
}

export async function getGenerateImages(): Promise<boolean> {
  return generateImagesFrom(await configGet(CODING_AGENT_GEN_IMAGES_CONFIG_KEY));
}

export async function setGenerateImages(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The picture switch must be true or false.");
  }
  await configSet(CODING_AGENT_GEN_IMAGES_CONFIG_KEY, on);
  return on;
}

export async function getGenerateAudio(): Promise<boolean> {
  return generateAudioFrom(await configGet(CODING_AGENT_GEN_AUDIO_CONFIG_KEY));
}

export async function setGenerateAudio(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The voice switch must be true or false.");
  }
  await configSet(CODING_AGENT_GEN_AUDIO_CONFIG_KEY, on);
  return on;
}

/** The browser switch. ON when absent — see its config key. */
function realBrowserFrom(raw: unknown): boolean {
  return raw !== false;
}

/**
 * Whether a browser session should be opened on the desktop Chromium the owner
 * can see. /setup-api/browser asks per session; nothing else reads it, because
 * which browser answered is then a property of the session, not of the run.
 */
export async function getRealBrowser(): Promise<boolean> {
  return realBrowserFrom(await configGet(CODING_AGENT_REAL_BROWSER_CONFIG_KEY));
}

export async function setRealBrowser(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The browser switch must be true or false.");
  }
  await configSet(CODING_AGENT_REAL_BROWSER_CONFIG_KEY, on);
  return on;
}

/** The team lead's switch. OFF unless it is exactly `true` — see its config key. */
export async function getTeamDynamic(): Promise<boolean> {
  return (await configGet(CODING_TEAM_DYNAMIC_CONFIG_KEY)) === true;
}

export async function setTeamDynamic(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The team lead switch must be true or false.");
  }
  await configSet(CODING_TEAM_DYNAMIC_CONFIG_KEY, on);
  return on;
}

/**
 * A refusal the owner can act on: the rule-level `code` beside the 400 every
 * other bad setting answers with.
 *
 * A subclass rather than a second error type, so every route that already
 * catches `CodingAgentError` keeps working unchanged — `httpStatusForCodingError`
 * reads `kind` and answers 400 — while the one route that knows about rules can
 * read `code` and let the panel say "that rule is already on the list" in the
 * owner's own language.
 */
export class AllowRuleError extends CodingAgentError {
  constructor(readonly code: AllowRuleRefusal, message: string) {
    super("invalid", message);
    this.name = "AllowRuleError";
  }
}

/**
 * The provider/model pair was not one this box can run on — the same 400 a bad
 * working folder answers, with a `code` that says WHICH argument was wrong.
 *
 * The subclass exists for the same reason `AllowRuleError` does, and is read by
 * a different caller: the MCP tool maps a 400 to advice for the model that
 * asked, and with only `kind: "invalid"` to go on it told a caller whose
 * provider/model pair was refused to pick a different working FOLDER. A run
 * naming `{ model: "claude-opus-5" }` on a box whose default account has no
 * model list is exactly that case, and the folder it was told to abandon was
 * fine.
 */
export class ProviderChoiceError extends CodingAgentError {
  readonly code = "provider" as const;
  constructor(message: string) {
    super("invalid", message);
    this.name = "ProviderChoiceError";
  }
}

/**
 * What this box refuses to every run, in the shape the rule validator reads.
 *
 * Read fresh per call: `fileDenyRules()` walks data/ and the checkout, so the
 * answer follows the box as files come and go. `BASH_KILL_DENYLIST` is the one
 * command list actually passed to the CLI; `BASH_DENYLIST` is documentation
 * today (see its comment) and is included anyway, because a command this device
 * has written down as never-allowed must not become allowable through this door
 * just because the current build grants `Bash(*)` and leans on the tool list.
 */
/**
 * A pipeline request this box will not accept.
 *
 * `ProviderChoiceError`'s sibling and for its reason: both are `invalid`, and a
 * caller that cannot tell "that is not a path" from "that folder is off limits"
 * has no idea which argument to fix. The code travels beside the 400.
 */
export class PipelineChoiceError extends CodingAgentError {
  constructor(readonly code: PipelineInputRefusal, message: string) {
    super("invalid", message);
    this.name = "PipelineChoiceError";
  }
}

/**
 * An `experience` field the box refused, with the reason's stable code beside
 * the shared 400 — so the dispatcher can tell "rule 3's id is malformed" from
 * "too many rules" without parsing a sentence. See readExperienceInput.
 */
export class ExperienceChoiceError extends CodingAgentError {
  constructor(readonly code: ExperienceInputRefusal, message: string) {
    super("invalid", message);
    this.name = "ExperienceChoiceError";
  }
}

export function allowRuleContext(): AllowRuleContext {
  return {
    denyRules: [...fileDenyRules(), ...BASH_KILL_DENYLIST, ...BASH_DENYLIST],
    homeDir: homeDir(),
  };
}

/**
 * The home alone, in the context shape — no directory walk.
 *
 * `softProjectDir` anchors a soft path at the home, so a validator given NO
 * context treats nothing as soft and drops every harness-project rule on the
 * floor. That is the safe default for an unknown box and the wrong answer for
 * this one, which knows its own home: the three readers that cannot afford
 * `allowRuleContext()`'s two readdirs — the status (read on a polled route), a
 * run record read back off disk, and `buildRunArgs`, where asking for the deny
 * rules would be circular — pass this instead. `denyRules` is empty on
 * purpose: the deny half is either applied elsewhere (the status only
 * displays) or computed from the very list being validated (`buildRunArgs`).
 */
export function allowRuleHomeContext(): AllowRuleContext {
  return { denyRules: [], homeDir: homeDir() };
}

/**
 * The owner's saved permission rules, re-validated on the way out.
 *
 * `context` is what makes that re-validation complete: without it a stored rule
 * clears the textual floor alone, with it the rule is judged against what this
 * box denies RIGHT NOW. Optional because it costs two directory walks
 * (`allowRuleContext`) and the status route is polled every few seconds, where
 * a rule that has gone inert is only ever displayed. Every path that puts rules
 * on a run's command line passes one.
 */
export async function getAllowRules(context?: AllowRuleContext): Promise<string[]> {
  return normalizeAllowRules(await configGet(CODING_AGENT_ALLOW_RULES_CONFIG_KEY), context);
}

/**
 * Save one rule — from the editor in Settings, or from "Allow next time" on a
 * refusal.
 *
 * The list on disk is read first and handed to the validator, so the duplicate
 * and the cap are decided against what is actually stored rather than against
 * whatever the browser last saw. Appended, never sorted: the owner reads their
 * own list in the order they built it.
 *
 * @param raw the rule as typed, or as the button offered it
 * @returns the whole list as it now stands
 * @throws AllowRuleError carrying the rule-level code on anything refused
 */
export async function addAllowRule(raw: unknown): Promise<string[]> {
  // One context for both halves: the list on disk is re-judged against the same
  // box the new rule is judged against, so a rule cannot be refused as a
  // duplicate of one that would itself no longer be accepted.
  const context = allowRuleContext();
  const rules = await getAllowRules(context);
  const verdict = validateAllowRule(raw, rules, context);
  if (!verdict.ok) throw new AllowRuleError(verdict.code, verdict.message);
  const next = [...rules, verdict.rule];
  await configSet(CODING_AGENT_ALLOW_RULES_CONFIG_KEY, next);
  return next;
}

/**
 * Take one rule off the list.
 *
 * Removing a rule that is not there SUCCEEDS, which is why this does not answer
 * 404: two open desktops poll the same status, and the second Remove of a rule
 * the first one already took off is the owner asking for a state the box is
 * already in. Narrowing what a run may do is never the request this device
 * refuses on a technicality.
 */
export async function removeAllowRule(raw: unknown): Promise<string[]> {
  if (typeof raw !== "string") {
    throw new AllowRuleError("malformed", "A permission rule must be text.");
  }
  const wanted = raw.trim();
  const rules = await getAllowRules();
  const next = rules.filter((rule) => rule !== wanted);
  // Nothing to write when nothing changed — the answer is still the list, so
  // the caller re-renders from the truth either way.
  if (next.length !== rules.length) {
    await configSet(CODING_AGENT_ALLOW_RULES_CONFIG_KEY, next);
  }
  return next;
}

/** Record that the owner finished (or re-entered) the setup wizard. */
export async function setSetupComplete(done: unknown): Promise<boolean> {
  if (typeof done !== "boolean") {
    throw new CodingAgentError("invalid", "The setup flag must be true or false.");
  }
  await configSet(CODING_AGENT_SETUP_CONFIG_KEY, done);
  return done;
}

/**
 * Put every coding-agent setting back to factory and send the owner to the
 * wizard: the switch off, no default folder, effort/ceilings/review back to
 * their defaults.
 *
 * The run history goes too. It was left alone at first — an audit trail is not
 * a setting — but "start over" that leaves last week's runs listed under a
 * freshly-configured agent is not starting over: the owner finished the wizard
 * and was met by the run they had just reset away. Finished runs and their
 * evidence folders are dropped, exactly as the runs list's own Clear does;
 * anything HELD (live, paused, drafted) is kept, because those hold a
 * resumable session and are not history yet.
 *
 * Deliberately NOT included: the GitHub credential. It is a login the owner
 * made against another service, not a setting of this device, and Settings has
 * its own two-tap Sign out for it.
 *
 * @returns how many finished runs were cleared, so the caller can say so.
 */
export async function resetCodingAgentSetup(): Promise<number> {
  const wasInjecting = await getInjectSecrets().catch(() => false);
  for (const key of CODING_AGENT_RESET_KEYS) {
    await configSet(key, undefined);
  }
  // The list above withdraws the owner's consent for injection too — a
  // switch-off the secrets' audit trail records like the owner's own, once the
  // config has actually been cleared.
  if (wasInjecting) await appendSecretAudit({ action: "switch_off", reason: "reset" });
  // The history setting is back to standard, so Claude Code's transcript
  // period goes back to whatever it was before "keep everything" changed it.
  // The ARCHIVE is not touched: it is kept data with a Clear of its own, not
  // a setting — and the owner who archived runs did so to keep them.
  await releaseHarnessTranscripts().catch((err) => {
    console.error("[coding-agent] could not hand back Claude Code's transcript period:", err instanceof Error ? err.message : err);
  });
  // Standard from here on — the setting was just cleared — so the Clear below
  // DELETES, as start-over always did, rather than filling the archive.
  rememberHistoryPolicy(STANDARD_HISTORY_POLICY);
  return clearFinishedRuns();
}

/** The owner's turn ceiling, clamped to something the CLI will accept. */
export async function getMaxTurns(): Promise<number> {
  return maxTurnsFrom(await configGet(CODING_AGENT_TURNS_CONFIG_KEY));
}

export async function setMaxTurns(turns: unknown): Promise<number> {
  if (typeof turns !== "number" || !Number.isFinite(turns)) {
    throw new CodingAgentError("invalid", "Steps must be a number.");
  }
  const n = Math.round(turns);
  if (n < MIN_MAX_TURNS || n > MAX_MAX_TURNS) {
    throw new CodingAgentError("invalid", `Steps must be between ${MIN_MAX_TURNS} and ${MAX_MAX_TURNS}.`);
  }
  await configSet(CODING_AGENT_TURNS_CONFIG_KEY, n);
  return n;
}

/** The owner's token ceiling, or null when they have not set one. */
export async function getTokenLimit(): Promise<number | null> {
  return tokenLimitFrom(await configGet(CODING_AGENT_TOKENS_CONFIG_KEY));
}

export async function setTokenLimit(limit: number | null): Promise<number | null> {
  if (limit === null) {
    await configSet(CODING_AGENT_TOKENS_CONFIG_KEY, undefined);
    return null;
  }
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new CodingAgentError("invalid", "The token limit must be a number, or empty for no limit.");
  }
  const n = Math.round(limit);
  if (n < MIN_TOKEN_LIMIT) {
    throw new CodingAgentError("invalid", `A token limit below ${MIN_TOKEN_LIMIT.toLocaleString("en-US")} would stop almost every run before it started.`);
  }
  await configSet(CODING_AGENT_TOKENS_CONFIG_KEY, n);
  return n;
}


/**
 * Folder names directly inside the owner's default project folder.
 *
 * The assistant could only ever see code projects — the 15 under
 * data/code-projects — so a folder the owner made themselves in ~/Projects
 * was invisible and could only be reached by typing its absolute path.
 * Names only: this is a picker, not a file listing.
 */
export async function listProjectFolders(): Promise<string[]> {
  return (await readProjectFolders())?.names ?? [];
}

/**
 * The owner's folder and the names in it. Null when no folder is set; a
 * folder that is set but cannot be read answers with no names, so the caller
 * can still say WHICH folder it looked in.
 */
async function readProjectFolders(): Promise<{ base: string; names: string[] } | null> {
  const base = await getDefaultDirectory();
  if (!base) return null;
  return { base, names: await readFolderNames(base) };
}

/**
 * The one readdir behind every listing: the folder names directly inside
 * `base`, or none when it cannot be read.
 *
 * `isDirectory()` on the Dirent, deliberately: a symlink is never followed,
 * so a link out of the folder is not offered as a project in it.
 */
/** The most folders a listing names — the readdir's and the run store's alike. */
const MAX_PROJECT_FOLDERS = 100;

async function readFolderNames(base: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_PROJECT_FOLDERS);
  } catch {
    return [];
  }
}

/**
 * Where code projects live: the folders code_project_init scaffolds and a run
 * given a project id works in. The code project library keeps this path to
 * itself (its one exported path helper, projectPath, answers per id), and
 * resolveWorkingDirectory below spells it out again for the same reason — a
 * listing needs the folder, not one project in it.
 */
const CODE_PROJECTS_DIR = path.join(DATA_DIR, "code-projects");

/** Where a listed project comes from: the owner's folder, or data/code-projects. */
export type CodingProjectKind = "folder" | "codeProject";

/** One project of the owner's, as the Coding Agent app lists it. */
export interface CodingProject {
  /** The folder's name — the name a run is given. For a code project, its id. */
  folder: string;
  /** The absolute folder. */
  directory: string;
  kind: CodingProjectKind;
  /** From project.json when the folder is a code project; the folder name otherwise. */
  name: string;
  lastCommit: LastCommit | null;
  /** Registered on the desktop as a web app (data/webapps/<folder>/meta.json). */
  onDesktop: boolean;
  /**
   * The project's own icon, once one has been drawn for it — the URL the app
   * puts in an <img>, not a path. Null while there is none, which is what the
   * row draws its lettered placeholder for.
   */
  iconUrl: string | null;
  /**
   * The newest run that worked in this folder, if any has.
   *
   * `reviewOf` travels with it because `task` is not always the run's TITLE:
   * an automatic review pass carries the whole REVIEW_PASS_TASK prompt, and
   * the New App card's "Last run:" line showed its first 120 characters
   * ("Automatic review pass. Start by running the project's own verification
   * — its tests or build — in THIS pass and quote the") where the sidebar,
   * the run page and the breadcrumb all say "Automatic review pass of
   * run-xyz". A caller cannot tell the two apart from `task` alone.
   */
  latestRun: Pick<CodingRun, "id" | "status" | "task" | "reviewOf" | "startedAt" | "completedAt"> | null;
  /**
   * The project's clawbox.json, when it carries one: what makes it a ClawBox
   * APP rather than a folder with history (src/lib/clawbox-manifest.ts). A
   * `port` here is what `/apps/<folder>/` is proxied to.
   */
  app: { name: string; description: string | null; kind: string | null; port: number | null } | null;
}

/**
 * The code project the Coding Agent app's Test-harness button runs its smoke
 * task in. The app keeps the same literal (HARNESS_TEST_PROJECT in
 * CodingAgentApp.tsx); the projects test holds the two together.
 */
export const HARNESS_TEST_PROJECT_ID = "harness-test";

/** A folder that may be a project, before describeProject has looked. */
interface ProjectCandidate {
  base: string;
  folder: string;
  kind: CodingProjectKind;
  /**
   * A folder directly under the project folder that a run has worked in.
   * Listed even without a `.git` of its own: every run happens in a folder
   * inside the project folder, and the owner asked for every such folder to
   * be a project — the run is how they find it again.
   */
  fromRun?: boolean;
}

/**
 * Every project the owner has, from both places one can be:
 *
 * - a folder directly inside their project folder with a `.git` DIRECTORY of
 *   its own. That test, and not "any folder", because a folder with its own
 *   history is what a run leaves behind (coding-git.ts commits every run's
 *   work) and what the owner can get back to. A `.git` FILE — a worktree or
 *   submodule pointer into somebody else's repository — is not counted, for
 *   the same reason the committer refuses such a folder;
 * - a code project under data/code-projects. That is where the New app
 *   wizard's handoff lands ("scaffold it as a code project"), and it can
 *   never be the owner's folder, because resolveWorkingDirectory refuses
 *   anything inside the checkout — so a list of the owner's folder alone
 *   could never show the app the wizard had just asked for. A code project
 *   counts once it has a project.json, which code_project_init writes before
 *   any run commits, so the app appears while it is being built and not only
 *   after.
 *
 * `directory` stays the owner's folder alone: it is what the empty state
 * names as the place to build in.
 *
 * Not the Test-harness button's scratch project: the app inits it for its
 * own smoke run, and a permanent "Harness Test" row beside the owner's real
 * projects read as one of them. The smoke run itself still shows, on the
 * app's home face with every run that belongs to no listed project.
 *
 * One `git log -1` per project, a few at a time: the app asks on its poll,
 * and a hundred concurrent spawns on a Jetson is a stall, not a listing.
 */
export async function listProjects(): Promise<{ directory: string | null; projects: CodingProject[] }> {
  const [folders, codeProjects] = await Promise.all([readProjectFolders(), readFolderNames(CODE_PROJECTS_DIR)]);
  const candidates: ProjectCandidate[] = [];
  if (folders) {
    // The folders runs have worked in, directly under the project folder: a
    // project by that run alone, `.git` or not. A run records the folder it
    // worked in symlink-resolved, so both spellings of the base are matched.
    // Never a dot-folder: that is state, not a project.
    const realBase = await fs.promises.realpath(folders.base).catch(() => folders.base);
    // Bounded like the readdir (readFolderNames keeps 100): the run store is
    // not a hard bound — held runs are never trimmed — and every folder here
    // costs a stat and a git log on every poll.
    const workedIn = new Set<string>();
    for (const run of loadRuns()) {
      if (workedIn.size >= MAX_PROJECT_FOLDERS) break;
      if (typeof run.directory !== "string") continue;
      const worked = projectDirectoryOf(run);
      for (const base of new Set([folders.base, realBase])) {
        if (!worked.startsWith(base + path.sep)) continue;
        const first = path.relative(base, worked).split(path.sep)[0];
        if (first && !first.startsWith(".")) workedIn.add(first);
      }
    }
    for (const folder of folders.names) {
      candidates.push({ base: folders.base, folder, kind: "folder", fromRun: workedIn.has(folder) });
    }
    for (const folder of workedIn) {
      if (!folders.names.includes(folder)) candidates.push({ base: folders.base, folder, kind: "folder", fromRun: true });
    }
  }
  for (const folder of codeProjects) {
    if (folder === HARNESS_TEST_PROJECT_ID) continue;
    candidates.push({ base: CODE_PROJECTS_DIR, folder, kind: "codeProject" });
  }
  const described = await mapLimit(candidates, 4, describeProject);

  // Once per real folder. config.json is a file the owner can edit, so the
  // project folder can be pointed at data/code-projects by hand, and every
  // project would then be listed twice. The owner's folder was described
  // first, so its row is the one kept.
  const seen = new Set<string>();
  const projects: CodingProject[] = [];
  for (const d of described) {
    if (!d || seen.has(d.real)) continue;
    seen.add(d.real);
    projects.push(d.project);
  }
  projects.sort((a, b) => (b.lastCommit?.date ?? 0) - (a.lastCommit?.date ?? 0) || a.name.localeCompare(b.name));
  return { directory: folders?.base ?? null, projects };
}

async function describeProject({ base, folder, kind, fromRun }: ProjectCandidate): Promise<{ project: CodingProject; real: string } | null> {
  const directory = path.join(base, folder);
  const [dotGit, metaName, self] = await Promise.all([
    fs.promises.stat(path.join(directory, ".git")).catch(() => null),
    projectNameOf(directory, folder),
    fromRun ? fs.promises.stat(directory).catch(() => null) : Promise.resolve(null),
  ]);
  const hasGit = dotGit?.isDirectory() === true;
  // A plain folder is a project by its history alone; a code project by its
  // project.json as well, since the scaffold comes before the first commit;
  // and a folder a run has worked in by that run, as long as it still exists.
  const workedIn = fromRun === true && self?.isDirectory() === true;
  if (!hasGit && !workedIn && !(kind === "codeProject" && metaName !== null)) return null;
  const [commit, onDesktop, hasIcon, manifest, real] = await Promise.all([
    // Only a folder with its own history is asked. `git log` in one without
    // walks UP to the nearest repository — for a code project, ClawBox's own
    // checkout — and would present the OS's last commit as the app's.
    hasGit ? lastCommit(directory) : Promise.resolve(null),
    isOnDesktop(folder),
    hasProjectIcon(folder),
    readClawboxManifest(directory),
    // A run records the folder it worked in symlink-resolved; match both
    // spellings so a project reached through a link still shows its run.
    fs.promises.realpath(directory).catch(() => directory),
  ]);
  // loadRuns() is newest first, so the first match is the latest run. A run
  // given a project id recorded the id as well as the folder.
  const run = loadRuns().find((r) => {
    // The project the run belongs to — its own copy of it, for a run with a
    // worktree, is two segments deeper and would match nothing here.
    const worked = projectDirectoryOf(r);
    return worked === real || worked === directory || (kind === "codeProject" && r.projectId === folder);
  }) ?? null;
  return {
    real,
    project: {
      folder,
      directory,
      kind,
      name: metaName ?? folder,
      lastCommit: commit,
      onDesktop,
      iconUrl: hasIcon ? `/setup-api/apps/icon/${folder}` : null,
      latestRun: run
        ? { id: run.id, status: run.status, task: run.task, reviewOf: run.reviewOf, startedAt: run.startedAt, completedAt: run.completedAt }
        : null,
      app: manifest ? { name: manifest.name, description: manifest.description, kind: manifest.kind, port: manifest.port } : null,
    },
  };
}

/**
 * The project's name from its project.json, bounded like a name the code
 * project library would accept — the file may have been written by hand —
 * or the folder's own name when the file has no usable one. Null when there
 * is no such file at all: that is what tells a code project from a folder
 * that merely sits under data/code-projects.
 */
async function projectNameOf(directory: string, folder: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readProjectJson(path.join(directory, "project.json"));
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const name = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
  } catch {
    // Not JSON, or not the shape expected: the folder's own name will do.
  }
  return folder;
}

/**
 * The most of a project.json this listing will read. code_project_init writes
 * a few hundred bytes; a delegated run can write anything into its folder,
 * and the app polls this listing — so a file it grew to gigabytes must not be
 * read into memory on every poll.
 */
const MAX_PROJECT_JSON_BYTES = 64 * 1024;

/**
 * project.json, read through one handle so the size checked is the size
 * read. Rejects when there is no such file (that is what tells a code
 * project from a plain folder under data/code-projects). A file over the
 * bound answers "" — which parses as nothing, so the folder's own name is
 * used, the same as for a file that is not JSON: it is still a project, it
 * just has no name this listing will trust.
 */
async function readProjectJson(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_PROJECT_JSON_BYTES) return "";
    // Never more than the bound, whatever the file grew to since the stat.
    const buf = Buffer.alloc(Math.min(size, MAX_PROJECT_JSON_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Whether the desktop knows this folder as a web app. A folder name that is
 * not a valid app id cannot be one, and is never spliced into a path under
 * data/webapps to find out.
 */
/**
 * Has a picture been drawn for this project (src/lib/project-icon.ts)?
 *
 * The same id rule as the desktop's, for the same reason: a folder name the
 * icon route would refuse is one no <img> could ever load, so it is never
 * spliced into a path under data/icons to find out.
 */
async function hasProjectIcon(folder: string): Promise<boolean> {
  if (!validateProjectId(folder)) return false;
  const icon = await fs.promises.stat(webappIconPath(folder)).catch(() => null);
  return icon?.isFile() === true;
}

async function isOnDesktop(folder: string): Promise<boolean> {
  if (!validateProjectId(folder)) return false;
  // `webappPath`, not a join of WEBAPPS_DIR: the folder name is rebuilt from
  // the alphabet there, the way hasProjectIcon's is by `webappIconPath`. The
  // `validateProjectId` above is the same rule, so it cannot refuse here.
  const meta = await fs.promises.stat(path.join(webappPath(folder), "meta.json")).catch(() => null);
  return meta?.isFile() === true;
}

/** `Promise.all` with at most `limit` items in flight. Order is preserved. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Readiness ───────────────────────────────────────────────────────────────

function homeDir(): string {
  return os.homedir();
}

export function wrapperPath(): string {
  return path.join(homeDir(), CODING_HARNESS_WRAPPER_PATH);
}

/**
 * The PATH a login shell on this box has, spelled out. The web server's own
 * PATH under systemd has no ~/.local/bin, so `command -v claude` inside the
 * wrapper — and any probe here that trusted process.env.PATH — would answer
 * "not installed" on a box where Claude Code works perfectly. install.sh's
 * `as_clawbox_login` uses this exact order.
 */
export function runnerPath(): string {
  const home = homeDir();
  return [
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    // Chromium ships as a snap on this device; without /snap/bin a run's
    // `which chromium` answers "not installed" and the run burns minutes
    // stubbing out a browser it actually has (seen on run-3750zcwc).
    "/snap/bin",
  ].join(":");
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file); // follows symlinks
    if (!stat.isFile()) return false;
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of `binary` on the runner's PATH, or null. */
export async function findExecutableOnPath(binary: string, pathValue: string = runnerPath()): Promise<string | null> {
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The fault THIS PROCESS knows about, beside the persisted one.
 *
 * Two copies of one fact, and both are needed, for two reasons that have
 * nothing to do with each other:
 *
 *  - finishRun cannot await, so the write is fired and forgotten. Between the
 *    call and the file landing there is a real window in which a second run —
 *    the agent starting a follow-up the moment the first settles — reads a
 *    config that says nothing is wrong and spawns straight into the same wall.
 *    This is set SYNCHRONOUSLY, before the first await, so that window is
 *    closed.
 *  - a write that rejects (a full disk, a permissions change) would otherwise
 *    lose the fault silently and take the whole pre-flight with it.
 *
 * The persisted copy is the durable one and outlives a restart; this one does
 * not, which is right — a web server that has just come up has seen nothing.
 * Both are read through `parseHarnessFault`, so the TTL is one rule rather
 * than two, and `clearHarnessFault` drops both.
 */
let liveHarnessFault: HarnessFault | null = null;

/**
 * Remember that the harness could not get a model to answer, so the next run
 * is refused before it spawns instead of dying the same way.
 *
 * Written from finishRun, which cannot await: the caller voids it. Nothing
 * here throws upward — a failed write costs the durable copy and nothing
 * else, because the in-memory one above is already set by then.
 */
async function rememberHarnessFault(): Promise<void> {
  // Synchronous, ahead of the await: see liveHarnessFault.
  liveHarnessFault = { at: Date.now() };
  await configSet(HARNESS_FAULT_CONFIG_KEY, { at: liveHarnessFault.at });
}

/**
 * Forget a recorded harness fault.
 *
 * Three callers, and they are the three ways a box gets out of refusing runs:
 * a run that COMPLETED (the only proof that matters), the owner saying so
 * through the enable route, and — without coming through here at all — the
 * fault simply ageing past its TTL.
 *
 * The key is DELETED rather than set to a falsy value: `parseHarnessFault`
 * would read either as "no fault", but a config file that accumulates dead
 * keys is one more thing for the next reader of it to wonder about.
 */
export async function clearHarnessFault(): Promise<void> {
  // First, and unconditionally: this is the copy that can refuse a run on its
  // own, so an early return over an absent config key must not leave it set.
  liveHarnessFault = null;
  if ((await configGet(HARNESS_FAULT_CONFIG_KEY)) === undefined) return;
  await configSet(HARNESS_FAULT_CONFIG_KEY, undefined);
}

export async function checkReadiness(): Promise<CodingHarnessReadiness> {
  const config = await configGetAll();
  return readinessWith(
    config.clawai_token,
    config[HARNESS_FAULT_CONFIG_KEY],
    codingProviderFrom(config[CODING_AGENT_PROVIDER_CONFIG_KEY]),
  );
}

/** Why an `anthropic` run cannot start, in the owner's words. */
const ANTHROPIC_MISSING =
  "Your Anthropic account is not connected. Open the Coding Agent app → Settings and save an Anthropic API key, or run `claude` in the Terminal app and sign in.";

const CLAWAI_MISSING =
  "ClawBox AI is not connected. Open Settings → AI Models and sign in to ClawBox AI first.";

/** Why an `openai` run cannot start, in the owner's words. */
const OPENAI_MISSING =
  "Your OpenAI account is not connected. Open the Coding Agent app → Settings and save an OpenAI API key, or sign in with ChatGPT there.";

const CODEX_MISSING =
  "The Codex CLI that OpenAI runs use is not installed on this ClawBox. Run: sudo bash install.sh --step codex_cli";

/**
 * The readiness probe proper, given the config values the caller already read.
 *
 * All three are REQUIRED, including the fault: optional, a caller that forgot
 * it would silently report a box as healthy, which is the one wrong answer
 * that field exists to stop.
 *
 * TWO LAYERS, because they have different remedies. The BOX's half — Claude
 * Code, the wrapper, setpriv, and a remembered harness fault — is wrong for
 * everyone, whichever account a run would be paid from. A PROVIDER's half is
 * one credential, and a box can be perfectly healthy on one provider and
 * unconnected on the other. `ready` is the box's half plus the DEFAULT
 * provider's, because that is the run a caller who names nothing gets.
 */
async function readinessWith(token: unknown, faultRaw: unknown, defaultProvider: CodingProvider): Promise<CodingHarnessReadiness> {
  const [wrapperInstalled, claudePath, setprivPath, anthropic, openai, scope] = await Promise.all([
    isExecutableFile(wrapperPath()),
    findExecutableOnPath("claude"),
    findExecutableOnPath(CAPABILITY_DROP_COMMAND),
    getAnthropicConnection(),
    getOpenAIConnection(),
    // Cached for a minute inside the module, so a status poll pays for the bus
    // round trip at most once a minute.
    probeSystemdRun(),
  ]);
  const claudeInstalled = claudePath !== null;
  const capabilityDropAvailable = setprivPath !== null;
  const clawaiConnected = typeof token === "string" && token.trim() !== "";
  const shared: string[] = [];
  // Claude Code and its wrapper are in the way of every provider that runs on
  // them — every one but `openai`, whose runs are the Codex CLI. They stay in
  // the SHARED list (the panels and the MCP probe read it) unless an `openai`
  // run is the only thing they would be stopping, which is said per provider.
  const claudeProblems: string[] = [];
  if (!claudeInstalled) {
    claudeProblems.push("Claude Code is not installed on this ClawBox. Run: sudo bash install.sh --step coding_harness");
  }
  if (!wrapperInstalled) {
    claudeProblems.push(`The ${CODING_HARNESS_COMMAND} wrapper is missing from ~/${CODING_HARNESS_WRAPPER_PATH}. Run: sudo bash install.sh --step coding_harness`);
  }
  if (!capabilityDropAvailable) {
    shared.push(`${CAPABILITY_DROP_COMMAND} (part of util-linux) is missing, and without it a run would inherit the web server's network capabilities. Install util-linux.`);
  }
  // The pieces above are all "is it installed" — answerable by looking at the
  // disk. This one is not: whether the plan covers the model the harness asks
  // for is upstream's to say, and the only honest way to know is that a run
  // has just been told no. So the probe reports what the box has SEEN, which
  // is what turns a column of identical dead runs into one clear refusal.
  // Either copy refuses. Both go through the same parser, so one TTL rule
  // governs them and an expired in-memory fault ages out exactly as the
  // persisted one does.
  //
  // In the SHARED half, not a provider's: a harness that could not get a model
  // to answer is not a fact about which account was going to pay, and a box in
  // that state cannot run on either.
  const fault: HarnessFault | null = parseHarnessFault(faultRaw) ?? parseHarnessFault(liveHarnessFault);
  const harnessHealthy = fault === null;
  if (fault) shared.push(harnessFaultProblem(fault));
  const credentialProblem = (id: CodingProvider): string[] => {
    if (id === "anthropic") return anthropic.connected ? [] : [ANTHROPIC_MISSING];
    if (id === "openai") {
      // The CLI first: a connected account with nothing to run it on is the
      // install's to fix, and saying "connect" would send the owner the wrong way.
      if (!openai.codexInstalled) return [CODEX_MISSING];
      return openai.connected ? [] : [OPENAI_MISSING];
    }
    return clawaiConnected ? [] : [CLAWAI_MISSING];
  };
  // The Claude Code half is shared by every provider but `openai`. Carried into
  // `shared` when any of the providers it stops is one the box would run — the
  // owner's default, or anything on a box with no OpenAI at all — so a
  // Claude-less box still reports itself as not ready; an `openai` run alone is
  // judged without it.
  const claudeShared = claudeProblems.length > 0 && !(runsOnCodex(defaultProvider) && openai.connected && openai.codexInstalled);
  if (claudeShared) shared.unshift(...claudeProblems);
  const providers: CodingProviderReadiness[] = CODING_PROVIDERS.map((id) => {
    const own = runsOnCodex(id)
      ? credentialProblem(id)
      : [...(claudeShared ? [] : claudeProblems), ...credentialProblem(id)];
    const blocking = runsOnCodex(id) ? shared.filter((m) => !claudeProblems.includes(m)) : shared;
    return {
      id,
      ready: blocking.length === 0 && own.length === 0,
      models: modelsForProvider(id),
      defaultModel: defaultModelForProvider(id),
      problems: own,
    };
  });
  const forDefault = providers.find((p) => p.id === defaultProvider) ?? providers[0];
  const anyProviderReady = providers.some((p) => p.ready);
  return {
    ready: forDefault.ready,
    wrapperInstalled,
    claudeInstalled,
    clawaiConnected,
    anthropicConnected: anthropic.connected,
    anthropicSource: anthropic.source,
    codexInstalled: openai.codexInstalled,
    openaiConnected: openai.connected,
    openaiSource: openai.source,
    capabilityDropAvailable,
    harnessHealthy,
    detachedRuns: scope.available,
    detachedRunsDetail: scope.detail,
    // The default provider's own missing credential belongs in the flat list
    // the panels already render, or a box whose default cannot run would show
    // "not ready" with an empty checklist.
    problems: [...shared, ...forDefault.problems],
    providers,
    anyProviderReady,
  };
}

/**
 * The BOX's half of a readiness answer — what is in every provider's way —
 * out of the flat list, which also carries the default provider's credential.
 */
function sharedProblems(readiness: CodingHarnessReadiness): string[] {
  return readiness.problems.filter((m) => !readiness.providers.some((p) => p.problems.includes(m)));
}

/** The owner's default provider. Anything unrecognised reads as ClawBox AI. */
export async function getCodingProvider(): Promise<CodingProvider> {
  return codingProviderFrom(await configGet(CODING_AGENT_PROVIDER_CONFIG_KEY));
}

/**
 * Store the owner's default provider.
 *
 * Deliberately NOT gated on that provider being connected: the owner may
 * reasonably choose Anthropic first and paste the key second, and a picker
 * that refused the first half of that would be unusable. What is gated is
 * STARTING a run — see assertProviderReady.
 */
export async function setCodingProvider(provider: string): Promise<CodingProvider> {
  if (!isCodingProvider(provider)) {
    throw new CodingAgentError("invalid", `Provider must be one of: ${CODING_PROVIDERS.join(", ")}.`);
  }
  await configSet(CODING_AGENT_PROVIDER_CONFIG_KEY, provider);
  return provider;
}

/**
 * The owner's CONNECTED providers (Settings → Coding agent → Connected
 * providers): the accounts a team's roles may run on. Never empty — a run
 * nobody names an account for needs one — so the last one cannot be
 * disconnected. The default provider follows the list when it was dropped
 * from it, and a role pinned to a provider that left the list goes back to
 * its default (provider and, with it, a model only that provider offers), so
 * no team starts on an account the owner just disconnected; `resetRoles`
 * names them for the screen.
 */
export async function setConnectedProviders(raw: unknown): Promise<{ providers: CodingProvider[]; resetRoles: ModelRole[] }> {
  if (!Array.isArray(raw) || raw.some((id) => !isCodingProvider(id))) {
    throw new CodingAgentError("invalid", `providers must be a list of: ${CODING_PROVIDERS.join(", ")}.`);
  }
  const providers = connectedProvidersFrom(raw, DEFAULT_CODING_PROVIDER);
  if (raw.length === 0) {
    throw new CodingAgentError("invalid", "At least one provider must stay connected: runs need an account to start on.");
  }
  await configSet(CODING_AGENT_CONNECTED_PROVIDERS_CONFIG_KEY, providers);
  const current = codingProviderFrom(await configGet(CODING_AGENT_PROVIDER_CONFIG_KEY));
  if (!providers.includes(current)) await configSet(CODING_AGENT_PROVIDER_CONFIG_KEY, providers[0]);
  const roles = await getRoleModels();
  const resetRoles = MODEL_ROLES.filter((role) => {
    const pinned = roles[role]?.provider;
    return pinned !== undefined && !providers.includes(pinned);
  });
  if (resetRoles.length > 0) {
    // `applyRoleModelsPatch` owns the rule: a provider put back to Default
    // takes with it a model only that provider offered, and leaves a tier.
    const next = applyRoleModelsPatch(roles, Object.fromEntries(resetRoles.map((role) => [role, { provider: ROLE_AUTO }])));
    if (next.ok) await configSet(CODING_AGENT_ROLE_MODELS_CONFIG_KEY, next.value);
  }
  return { providers, resetRoles };
}

/** The connected providers as stored (the default provider alone on a record from before the list). */
export async function getConnectedProviders(): Promise<CodingProvider[]> {
  const config = await configGetAll();
  return connectedProvidersFrom(config[CODING_AGENT_CONNECTED_PROVIDERS_CONFIG_KEY], codingProviderFrom(config[CODING_AGENT_PROVIDER_CONFIG_KEY]));
}

/**
 * The shape a stored model id may have. Not the OFFERED list — see below —
 * but a floor, because this value is handed to the CLI through an environment
 * variable and the file it comes from is the only thing vouching for it.
 */
const STORED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

/**
 * A stored model as the record gets it back.
 *
 * A model the OFFERED list no longer carries is KEPT, not replaced. The list
 * is what a caller may ASK for; the record is what a run was started with, and
 * a resume re-enters a session opened on that exact model. Substituting the
 * current default here would have the run answer on a different model than the
 * one it is recorded as having used, silently — and a resume onto a model the
 * account has since lost should fail saying so, which is what the wrapper and
 * Anthropic between them do.
 *
 * Only the provider half is authoritative: a `clawbox-ai` run has no model of
 * its own (the plan chooses), so anything stored against it is dropped.
 */
function normalizeRequestedModel(provider: unknown, raw: unknown): string | null {
  const resolved = codingProviderFrom(provider);
  // A provider whose plan picks the model carries none — except its economy
  // model, which only the box itself sets, on a team's planner or reviewer
  // (src/lib/coding-role-models.ts).
  if (modelsForProvider(resolved).length === 0) return isRecordableModel(resolved, raw) ? raw : defaultModelForProvider(resolved);
  if (typeof raw === "string" && STORED_MODEL_RE.test(raw)) return raw;
  return defaultModelForProvider(resolved);
}

/**
 * Refuse a run whose provider has no credential, before anything spawns.
 *
 * Fails the same way the harness check does — a `not_ready` CodingAgentError,
 * which the route maps to 409 and the MCP layer to CONFLICT/do-not-retry —
 * because "you have not connected that account" is the same kind of answer as
 * "Claude Code is not installed": a sentence for the owner, not a retry.
 */
async function assertProviderReady(provider: CodingProvider): Promise<void> {
  if (provider === "anthropic") {
    const anthropic = await getAnthropicConnection();
    if (!anthropic.connected) throw new CodingAgentError("not_ready", ANTHROPIC_MISSING);
    return;
  }
  if (provider === "openai") {
    const openai = await getOpenAIConnection();
    if (!openai.codexInstalled) throw new CodingAgentError("not_ready", CODEX_MISSING);
    if (!openai.connected) throw new CodingAgentError("not_ready", OPENAI_MISSING);
    return;
  }
  const token = await configGet("clawai_token");
  if (typeof token !== "string" || token.trim() === "") {
    throw new CodingAgentError("not_ready", CLAWAI_MISSING);
  }
}

export async function getCodingAgentStatus(): Promise<CodingAgentStatus> {
  // One read of config.json for every setting the status carries — the app
  // polls this, and each getter above opens and parses the file on its own.
  const config = await configGetAll();
  const enabled = codingAgentEnabledFrom(config[CODING_AGENT_CONFIG_KEY]);
  const defaultDirectory = defaultDirectoryFrom(config[CODING_AGENT_DIR_CONFIG_KEY]);
  const effort = effortFrom(config[CODING_AGENT_EFFORT_CONFIG_KEY]);
  const provider = codingProviderFrom(config[CODING_AGENT_PROVIDER_CONFIG_KEY]);
  const [readiness, projectFolders] = await Promise.all([
    readinessWith(config.clawai_token, config[HARNESS_FAULT_CONFIG_KEY], provider),
    defaultDirectory ? readFolderNames(defaultDirectory) : Promise.resolve([]),
  ]);
  return {
    enabled,
    // Off the SAME config snapshot as everything else here — the app polls
    // this route, and `readClawaiEntitlementTier` would open the file again
    // for two keys we already hold. `clawaiEntitlementTier` is the one rule
    // for reading the plan/badge pair, so this cannot disagree with the
    // routes that refuse on it.
    planGate: planGateFor(clawaiEntitlementTier(config[CLAWAI_PLAN_TIER_KEY], config.clawai_tier)),
    defaultDirectory,
    suggestedDirectory: suggestedDefaultDirectory(),
    ready: enabled && readiness.ready,
    readiness,
    running: runningCount(),
    reviewPass: config[CODING_AGENT_REVIEW_CONFIG_KEY] === true,
    autoPr: config[CODING_AGENT_AUTO_PR_CONFIG_KEY] === true,
    // Absent means "summary": a box that predates the setting stops pasting a
    // whole task into a public pull request the day it updates.
    prBodyIncludesTask: prBodyTaskModeFrom(config[CODING_AGENT_PR_BODY_TASK_CONFIG_KEY]),
    // Absent means the DEFAULT here, not zero: a box that predates the loop
    // gets it, which is the point of shipping it on.
    reviewRounds: typeof config[CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY] === "number"
      ? clampReviewRounds(config[CODING_AGENT_REVIEW_ROUNDS_CONFIG_KEY])
      : DEFAULT_REVIEW_ROUNDS,
    minReviewRounds: MIN_REVIEW_ROUNDS,
    maxReviewRounds: MAX_REVIEW_ROUNDS,
    autoMerge: config[CODING_AGENT_AUTO_MERGE_CONFIG_KEY] === true,
    // Absent means the default, like the review rounds above: a box that
    // predates the setting still gives a run with a deliverable its three goes.
    completionAttempts: completionAttemptsFrom(config[CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY]),
    // The effective diet: DEFAULT_DIET (lean) on every knob the owner never set.
    diet: readDiet(config[CODING_AGENT_DIET_CONFIG_KEY], DEFAULT_DIET),
    minCompletionAttempts: MIN_COMPLETION_ATTEMPTS,
    maxCompletionAttempts: MAX_COMPLETION_ATTEMPTS,
    // Absent means the default here too: a box that predates the setting runs
    // two at once, which is what shipping it on means.
    maxParallelRuns: maxParallelRunsFrom(config[CODING_AGENT_MAX_PARALLEL_CONFIG_KEY]),
    minMaxParallelRuns: MIN_MAX_PARALLEL_RUNS,
    maxMaxParallelRuns: hostMaxParallelRuns(),
    // Absent means standard — what every box did before the setting existed.
    ...(() => {
      const history = rememberHistoryPolicy(historyPolicyFrom(config[CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY], config[CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY]));
      return {
        historyRetention: history.mode,
        historyLimit: history.limit,
        historyLimits: [...HISTORY_EXTENDED_LIMITS],
        historyLiveKept: MAX_RUNS_KEPT,
      };
    })(),
    generateImages: generateImagesFrom(config[CODING_AGENT_GEN_IMAGES_CONFIG_KEY]),
    generateAudio: generateAudioFrom(config[CODING_AGENT_GEN_AUDIO_CONFIG_KEY]),
    realBrowser: realBrowserFrom(config[CODING_AGENT_REAL_BROWSER_CONFIG_KEY]),
    teamDynamic: config[CODING_TEAM_DYNAMIC_CONFIG_KEY] === true,
    // The home, so a harness-project rule is still on the list the panels
    // read; the full context's directory walk is not worth it here.
    allowRules: normalizeAllowRules(config[CODING_AGENT_ALLOW_RULES_CONFIG_KEY], allowRuleHomeContext()),
    maxAllowRules: MAX_ALLOW_RULES,
    // Read off the same config snapshot as everything else here rather than
    // through `getInjectSecrets`, which would open the file a second time on a
    // route the app polls. `=== true` is the same reading that getter makes.
    injectSecrets: config[SECRET_INJECT_CONFIG_KEY] === true,
    // Normalized on the way out as well as on the way in: a value stored before
    // the validation existed must not be shown back as if the device would use
    // it, because the resolver would refuse exactly the same value.
    gitAuthorName: normalizeCodingGitName(config[CODING_AGENT_GIT_NAME_CONFIG_KEY]),
    gitAuthorEmail: normalizeCodingGitEmail(config[CODING_AGENT_GIT_EMAIL_CONFIG_KEY]),
    maxGitAuthorChars: MAX_GIT_IDENTITY_CHARS,
    harnessCommand: CODING_HARNESS_COMMAND,
    maxTaskChars: MAX_TASK_CHARS,
    provider,
    providers: CODING_PROVIDERS,
    connectedProviders: connectedProvidersFrom(config[CODING_AGENT_CONNECTED_PROVIDERS_CONFIG_KEY], provider),
    effort,
    // Always include whatever is actually set. A box that stored "high"
    // before the picker narrowed to three would otherwise show a row with
    // nothing selected, and the owner could not tell what was in force.
    effortLevels: OFFERED_EFFORT_LEVELS.includes(effort)
      ? OFFERED_EFFORT_LEVELS
      : (EFFORT_LEVELS.filter((l) => OFFERED_EFFORT_LEVELS.includes(l) || l === effort) as readonly CodingEffort[]),
    // Every role, every half, "auto" where nothing is stored — a box that
    // never chose answers all "auto" and runs on the role defaults.
    roleModels: roleModelsView(roleModelsFrom(config[CODING_AGENT_ROLE_MODELS_CONFIG_KEY])),
    // Off the same snapshot and the readiness above: no second probe per poll.
    roleModelMap: roleModelMapFrom(config, readiness),
    projectFolders,
    maxTurns: maxTurnsFrom(config[CODING_AGENT_TURNS_CONFIG_KEY]),
    minMaxTurns: MIN_MAX_TURNS,
    maxMaxTurns: MAX_MAX_TURNS,
    tokenLimit: tokenLimitFrom(config[CODING_AGENT_TOKENS_CONFIG_KEY]),
    minTokenLimit: MIN_TOKEN_LIMIT,
    runIdleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
    // An EXPLICIT flag always wins; `enabled` only stands in when there is no
    // flag at all.
    //
    // The fallback exists for a box configured before the wizard did, whose
    // owner must not be sent back through onboarding. But `flag === true ||
    // enabled` made the switch itself mean "finished", and the wizard turns the
    // switch on at step 2 so its last step has an agent to test — so the app
    // decided setup was complete mid-wizard and swapped the last step for the
    // home page about a second after it appeared.
    setupComplete: typeof config[CODING_AGENT_SETUP_CONFIG_KEY] === "boolean"
      ? config[CODING_AGENT_SETUP_CONFIG_KEY] === true
      // An explicit `true` only: the switch is ON by default now, and an absent
      // key is a box nobody has set up, not one set up before the wizard.
      : config[CODING_AGENT_CONFIG_KEY] === true,
  };
}

// ─── The runs store ──────────────────────────────────────────────────────────
//
// Same discipline as src/lib/email-pending.ts: one JSON file under DATA_DIR,
// written 0600 through a temp file and an atomic rename, a corrupt file read
// as empty. SYNC fs on purpose — an await between read and write is how two
// progress events from one run would lose each other's updates.

const RUNS_PATH = path.join(DATA_DIR, "coding-agent-runs.json");

// isCodingRun gates readAll, so the status check must know EVERY status
// persist() can write — a status it did not know made a restart silently
// DELETE the record (paused runs and drafts vanished, found the hard way).
// That is why the list lives in coding-agent-status.ts and nowhere else.
function isCodingRun(value: unknown): value is CodingRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && typeof v.task === "string"
    && typeof v.directory === "string"
    && isCodingRunStatus(v.status)
    && typeof v.startedAt === "number"
  );
}

/**
 * A stored `pr` blob, rebuilt field by field the way normalizeRun rebuilds
 * the run around it. One without a phase or a start is not a pull request and
 * is dropped; anything else wrong in it is repaired to its default rather
 * than trusted — a `number` that is not a number reached `gh pr view` as an
 * argument, and a count that was not a count reached the owner as
 * "undefined of undefined checks".
 */
function normalizeTeam(raw: unknown): RunTeam | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return null;
  // Every role the team has: a reviewer run reloaded without its team would
  // be resumed and settled as a project run — icon, review pass, pull
  // request — in a folder that is the team's.
  if (t.role !== "planner" && t.role !== "worker" && t.role !== "reviewer" && t.role !== "lead") return null;
  return {
    id: t.id,
    role: t.role,
    taskId: typeof t.taskId === "string" ? t.taskId : null,
    // Only a worker's, and only `true`: absent stays absent, so a record from
    // before the field reads back exactly as it was written.
    ...(t.role === "worker" && t.bulk === true ? { bulk: true } : {}),
  };
}

/**
 * A stored `experience` summary, rebuilt field by field. Ids this code could
 * not have written are dropped rather than trusted: the training cluster joins
 * on them, and a hand-edited record must not credit a rule with a run it never
 * reached.
 */
function parseRunExperience(raw: unknown): RunExperience | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  return {
    ruleIds: Array.isArray(v.ruleIds) ? v.ruleIds.filter((id): id is string => typeof id === "string" && EXPERIENCE_RULE_ID.test(id)) : [],
    skill: v.skill === true,
    chars: typeof v.chars === "number" && Number.isFinite(v.chars) && v.chars >= 0 ? Math.round(v.chars) : 0,
  };
}

function normalizePr(raw: unknown): PrState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Partial<Record<keyof PrState, unknown>>;
  if (!isPrPhase(v.phase) || typeof v.startedAt !== "number") return null;
  const checks = (typeof v.checks === "object" && v.checks !== null ? v.checks : {}) as Partial<Record<keyof PrChecks, unknown>>;
  const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
  return {
    phase: v.phase,
    number: typeof v.number === "number" && Number.isInteger(v.number) && v.number > 0 ? v.number : null,
    url: typeof v.url === "string" ? v.url : null,
    branch: typeof v.branch === "string" ? v.branch : null,
    base: typeof v.base === "string" ? v.base : null,
    checks: { total: count(checks.total), passed: count(checks.passed), failed: count(checks.failed), pending: count(checks.pending) },
    detail: typeof v.detail === "string" ? v.detail : null,
    startedAt: v.startedAt,
    endedAt: typeof v.endedAt === "number" ? v.endedAt : null,
    // A verdict the record does not carry is not a pass: only `true` written
    // by this code counts, so a record from before the field merges nothing
    // on its own.
    reviewOk: v.reviewOk === true,
    // Null, never a guess: a record from before the field says nothing about
    // who opened its pull request, and "opened" would be this code claiming
    // credit it has no evidence for.
    foundBy: isPrFoundBy(v.foundBy) ? v.foundBy : null,
    readyAt: typeof v.readyAt === "number" && Number.isFinite(v.readyAt) ? v.readyAt : null,
    autoMergeAt: typeof v.autoMergeAt === "number" && Number.isFinite(v.autoMergeAt) ? v.autoMergeAt : null,
    autoMergeFailedAt: typeof v.autoMergeFailedAt === "number" && Number.isFinite(v.autoMergeFailedAt) ? v.autoMergeFailedAt : null,
  };
}

/** Fill in fields an older on-disk record may lack, so readers never see undefined. */
function normalizeRun(raw: CodingRun): CodingRun {
  return {
    id: raw.id,
    task: raw.task,
    directory: raw.directory,
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    source: raw.source === "owner" ? "owner" : "agent",
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    model: typeof raw.model === "string" ? raw.model : null,
    // A record written before the selector existed ran on ClawBox AI, which
    // is what the default answers — there was nothing else to run on.
    provider: codingProviderFrom(raw.provider),
    requestedModel: normalizeRequestedModel(raw.provider, raw.requestedModel),
    // Null on a record from before the field, a solo run's, or a hand edit.
    modelRole: readModelRole((raw as { modelRole?: unknown }).modelRole),
    anthropicAccount: typeof raw.anthropicAccount === "string" && /^[0-9a-f]{8}$/.test(raw.anthropicAccount) ? raw.anthropicAccount : null,
    accountSwitches: normalizeAccountSwitches((raw as { accountSwitches?: unknown }).accountSwitches),
    summary: typeof raw.summary === "string" ? raw.summary : null,
    resultText: typeof raw.resultText === "string" ? raw.resultText : null,
    error: typeof raw.error === "string" ? raw.error : null,
    numTurns: typeof raw.numTurns === "number" ? raw.numTurns : 0,
    filesTouched: Array.isArray(raw.filesTouched) ? raw.filesTouched.filter((f) => typeof f === "string") : [],
    commandsRun: typeof raw.commandsRun === "number" ? raw.commandsRun : 0,
    deniedActions: Array.isArray(raw.deniedActions)
      ? raw.deniedActions.filter((d): d is string => typeof d === "string")
      : [],
    // A record from before the structured list existed keeps its strings and
    // gets no buttons — deriving a rule by re-parsing "Bash: curl …" would be
    // guessing at what the tool was pointed at, and the one thing a button that
    // widens a permission may not do is guess.
    denials: Array.isArray(raw.denials)
      ? raw.denials
        .filter((d): d is CodingDenial => !!d && typeof d === "object" && typeof (d as CodingDenial).text === "string")
        .map((d) => ({
          text: d.text,
          rule: typeof d.rule === "string" ? d.rule : null,
          // A code this build does not know is dropped rather than passed on:
          // the page words it from a fixed table, and an unknown code would
          // render as nothing beside a refusal that then explains itself twice.
          refusal: isAllowRuleRefusal(d.refusal) ? d.refusal : null,
          ...(typeof d.worktreePath === "string" && path.isAbsolute(d.worktreePath) ? { worktreePath: d.worktreePath } : {}),
          // Only as what it claims to be: the rest of `text`, within its bound.
          ...(typeof d.fullText === "string" && d.fullText.length > d.text.length && d.fullText.startsWith(d.text)
            ? { fullText: d.fullText.slice(0, MAX_DENIAL_FULL_CHARS) }
            : {}),
        }))
      : [],
    worktreeHints: typeof raw.worktreeHints === "number" && Number.isFinite(raw.worktreeHints) && raw.worktreeHints > 0 ? Math.floor(raw.worktreeHints) : 0,
    // Re-validated rather than trusted: this list is what a resume hands to the
    // CLI, and the floor it had to clear when the run started may have risen.
    allowRules: normalizeAllowRules(raw.allowRules, allowRuleHomeContext()),
    // Only a hand-over this code could have written: the folder is drawn on the
    // run's page and named to the harness, so half a record is no record at all
    // — read as `null`, which the page renders as "this build cannot say"
    // rather than as an empty inputs folder.
    inputs: (() => {
      const v = (raw as { inputs?: unknown }).inputs as { dir?: unknown; files?: unknown } | null | undefined;
      if (!v || typeof v !== "object" || typeof v.dir !== "string" || !v.dir) return null;
      const files = Array.isArray(v.files)
        ? v.files
          .filter((f): f is RunInputFile => !!f && typeof f === "object"
            && typeof (f as RunInputFile).name === "string" && typeof (f as RunInputFile).bytes === "number")
          .slice(0, MAX_RUN_INPUTS)
          .map((f) => ({ name: f.name, bytes: f.bytes }))
        : [];
      // A code this build does not know is dropped with its row rather than
      // passed on: the page words it from a fixed table, and an unknown code
      // would draw a refusal with no reason beside it.
      const refusedRaw = (v as { refused?: unknown }).refused;
      const refused = Array.isArray(refusedRaw)
        ? refusedRaw
          .flatMap((r) => {
            const e = r as { name?: unknown; code?: unknown } | null;
            if (!e || typeof e !== "object" || typeof e.name !== "string" || !isInputRefusalCode(e.code)) return [];
            return [{ name: e.name, code: e.code }];
          })
          .slice(0, MAX_RUN_INPUTS)
        : [];
      // The shared folder is NOT read back off the record: it is one folder on
      // this box, and a stale path in an old file would send the owner to a
      // folder nothing reads.
      return { dir: v.dir, shared: sharedInputsDir(), files, refused };
    })(),
    // A record from before the store existed has none. The names are re-filtered
    // rather than trusted: this list is rendered, and the file it comes from is
    // the one a restore or a hand edit can have touched.
    secretNames: Array.isArray((raw as { secretNames?: unknown }).secretNames)
      ? ((raw as { secretNames: unknown[] }).secretNames)
          .filter((v): v is string => typeof v === "string" && SECRET_NAME_RE.test(v))
          .slice(0, MAX_SECRETS)
      : [],
    effort: isEffort(raw.effort) ? raw.effort : DEFAULT_EFFORT,
    // A record written before this field existed, or one left by a restart,
    // has no live sub-agents by definition.
    subagentsActive: 0,
    // A record loaded from disk has none out by definition.
    activeSubagents: [],
    subagents: Array.isArray((raw as { subagents?: unknown }).subagents)
      ? ((raw as { subagents: unknown[] }).subagents).flatMap((s) => {
          const h = s as Record<string, unknown> | null;
          if (!h || typeof h.type !== "string" || typeof h.startedAt !== "number") return [];
          return [{
            type: h.type,
            description: typeof h.description === "string" ? h.description : "",
            startedAt: h.startedAt,
            endedAt: typeof h.endedAt === "number" ? h.endedAt : h.startedAt,
            refused: h.refused === true,
          }];
        }).slice(-SUBAGENT_HISTORY_KEPT)
      : [],
    subagentsTotal: typeof raw.subagentsTotal === "number" ? raw.subagentsTotal : 0,
    subagentsByType: (raw.subagentsByType && typeof raw.subagentsByType === "object")
      ? (raw.subagentsByType as Record<string, number>) : {},
    commit: typeof raw.commit === "string" ? raw.commit : null,
    modelsUsed: Array.isArray(raw.modelsUsed)
      ? raw.modelsUsed.filter((m): m is string => typeof m === "string") : [],
    maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : DEFAULT_MAX_TURNS,
    tokensUsed: typeof raw.tokensUsed === "number" ? raw.tokensUsed : 0,
    tokenBreakdown: readTokenBreakdown((raw as { tokenBreakdown?: unknown }).tokenBreakdown),
    spawnTokens: Array.isArray((raw as { spawnTokens?: unknown }).spawnTokens)
      ? ((raw as { spawnTokens: unknown[] }).spawnTokens).filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0).slice(-MAX_SPAWN_TOKENS_KEPT)
      : [],
    tokenLimit: typeof raw.tokenLimit === "number" ? raw.tokenLimit : null,
    thinkingTokens: typeof raw.thinkingTokens === "number" ? raw.thinkingTokens : 0,
    ...(readCodexThreadUsage((raw as { codexThreadUsage?: unknown }).codexThreadUsage) ?? {}),
    lastActivityAt: typeof raw.lastActivityAt === "number" ? raw.lastActivityAt : 0,
    retries: typeof raw.retries === "number" ? raw.retries : 0,
    permissionDenials: typeof raw.permissionDenials === "number" ? raw.permissionDenials : 0,
    resumable: raw.resumable === true,
    // Only the one verdict this code writes counts; anything else on a
    // hand-edited record is no verdict at all.
    failureKind: raw.failureKind === "harness_not_ready" ? "harness_not_ready" : null,
    // Only a reason this code could have written counts: anything else on a
    // hand-edited record is no reason at all, not a new kind of pause.
    pauseReason: parsePauseReason(raw.pauseReason),
    reviewOf: typeof raw.reviewOf === "string" ? raw.reviewOf : null,
    team: normalizeTeam(raw.team),
    readOnly: raw.readOnly === true,
    extraBrief: typeof raw.extraBrief === "string" && raw.extraBrief ? raw.extraBrief : null,
    cpuBudget: typeof raw.cpuBudget === "number" && Number.isInteger(raw.cpuBudget) && raw.cpuBudget >= 1 && raw.cpuBudget <= MAX_CPU_BUDGET ? raw.cpuBudget : null,
    experience: parseRunExperience(raw.experience),
    // No longer than the renderer ever writes: a longer one on a hand-edited
    // record is not a block this box rendered, and it travels into a prompt.
    experienceBrief: typeof raw.experienceBrief === "string" && raw.experienceBrief && raw.experienceBrief.length <= EXPERIENCE_BLOCK_MAX_CHARS
      ? raw.experienceBrief
      : null,
    // Every field must be reconstructed here: normalizeRun builds a fresh
    // object field by field, so anything omitted survives in memory and
    // disappears the next time the file is read.
    pr: normalizePr(raw.pr),
    // Only a loop this code could have written counts; anything else on a
    // hand-edited record is no loop at all, the way parsePauseReason treats a
    // reason it does not recognise.
    review: parseReviewLoop((raw as { review?: unknown }).review),
    reviewLoopOf: typeof (raw as { reviewLoopOf?: unknown }).reviewLoopOf === "string"
      ? (raw as { reviewLoopOf: string }).reviewLoopOf
      : null,
    reviewRound: (() => {
      const n = (raw as { reviewRound?: unknown }).reviewRound;
      return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
    })(),
    // Strict, and the safe direction to fall: a record whose pipeline this
    // build cannot read has none, and settles the way a run without one does.
    pipeline: parsePipeline((raw as { pipeline?: unknown }).pipeline),
    progress: Array.isArray(raw.progress) ? raw.progress.filter((p) => typeof p === "string") : [],
    // Only a list that matches the lines one for one is a list of their times;
    // a record from before the field has none, and the timeline says nothing.
    progressAt: (() => {
      const lines = Array.isArray(raw.progress) ? raw.progress.filter((p) => typeof p === "string").length : 0;
      const at = Array.isArray((raw as { progressAt?: unknown }).progressAt) ? ((raw as { progressAt: unknown[] }).progressAt) : [];
      return at.length === lines && at.every((n) => typeof n === "number") ? (at as number[]) : [];
    })(),
    todos: parseTodos(raw.todos) ?? [],
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    // A record written before the media switches existed had neither tool, so
    // "off" is the truth about that run and not merely a safe default.
    media: normalizeMedia(raw.media),
    reviewPass: raw.reviewPass === true,
    // Strict, and never a throw: a record from before the diet reads as
    // LEGACY_DIET — the brief and the tools it was started with — and never as
    // the lean DEFAULT_DIET, or its resumes would change prompt mid-session.
    diet: readDiet((raw as { diet?: unknown }).diet, LEGACY_DIET),
    visual: typeof (raw as { visual?: unknown }).visual === "boolean" ? (raw as { visual: boolean }).visual : null,
    mediaGenerated: {
      images: countOf(raw.mediaGenerated?.images),
      audio: countOf(raw.mediaGenerated?.audio),
    },
    pgid: typeof raw.pgid === "number" && raw.pgid > 0 ? raw.pgid : null,
    // Only a name this code could have written: the string reaches
    // `systemctl stop`, so anything else on a hand-edited record is no unit at
    // all and the run falls back to being judged by its pgid.
    unit: isRunScopeUnit((raw as { unit?: unknown }).unit) ? (raw as { unit: string }).unit : null,
    streamOffset: (() => {
      const at = (raw as { streamOffset?: unknown }).streamOffset;
      return typeof at === "number" && Number.isFinite(at) && at > 0 ? Math.floor(at) : 0;
    })(),
    leftover: raw.leftover === true,
    commitError: typeof raw.commitError === "string" ? raw.commitError : null,
    // Only a worktree this code could have written: the path reaches
    // `git worktree remove` and `rm`, so a hand-edited record with half a
    // worktree on it is no worktree at all and the run is read as one working
    // in its folder — which is what every record written before this is.
    worktree: parseRunWorktree((raw as { worktree?: unknown }).worktree),
    // Only a deliverable this code could have written counts; anything else on
    // a hand-edited record is no deliverable at all, the way parsePauseReason
    // treats a reason it does not recognise. A record that loses its
    // deliverable this way settles the old way, which is the safe direction:
    // it cannot make a run give up on a bar nothing here can word.
    deliverable: parseDeliverable((raw as { deliverable?: unknown }).deliverable),
    deliverableCheck: parseDeliverableVerdict((raw as { deliverableCheck?: unknown }).deliverableCheck),
    attempts: parseAttempts((raw as { attempts?: unknown }).attempts),
    completionAttempts: completionAttemptsFrom((raw as { completionAttempts?: unknown }).completionAttempts),
    // Re-validated rather than trusted, like every other list here: this text
    // is written to the harness's stdin and drawn on the run's page, and the
    // file it comes from is one a restore or a hand edit can have touched.
    messages: parseRunMessages((raw as { messages?: unknown }).messages),
    midTurn: (raw as { midTurn?: unknown }).midTurn === true,
    queued: (raw as { status?: unknown }).status === "queued" ? parseQueueEntry((raw as { queued?: unknown }).queued) : null,
    ci: parseRunCi((raw as { ci?: unknown }).ci),
    ciFixOf: parseCiFixOf((raw as { ciFixOf?: unknown }).ciFixOf),
  };
}

/** A run's CI failure off disk, or null — rendered on its page and quoted to the next run, so re-read, never trusted. */
function parseRunCi(raw: unknown): RunCi | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.prNumber !== "number" || !Number.isInteger(c.prNumber) || c.prNumber <= 0) return null;
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
  return {
    prNumber: c.prNumber,
    at: typeof c.at === "number" ? c.at : 0,
    checks: strings(c.checks, 40),
    tests: strings(c.tests, 40),
    files: strings(c.files, 40),
    excerpt: typeof c.excerpt === "string" ? c.excerpt.slice(0, 4_000) : "",
    unread: strings(c.unread, 40),
    attempt: typeof c.attempt === "number" && Number.isInteger(c.attempt) && c.attempt >= 0 ? c.attempt : 0,
    fixRunId: typeof c.fixRunId === "string" && RUN_ID_RE.test(c.fixRunId) ? c.fixRunId : null,
  };
}

function parseCiFixOf(raw: unknown): { runId: string; attempt: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.runId !== "string" || !RUN_ID_RE.test(f.runId)) return null;
  return { runId: f.runId, attempt: typeof f.attempt === "number" && Number.isInteger(f.attempt) && f.attempt > 0 ? f.attempt : 1 };
}

/** A queued run's entry off disk, or a bare one (its turn by when the file says it was asked, no request) — never a crash. */
function parseQueueEntry(raw: unknown): RunQueueEntry {
  const e = raw && typeof raw === "object" ? raw as { at?: unknown; start?: unknown } : {};
  const start = e.start && typeof e.start === "object" ? e.start as Record<string, unknown> : {};
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : 0,
    start: {
      kind: start.kind === "new" ? "new" : "draft",
      ...(typeof start.task === "string" ? { task: start.task } : {}),
      projectId: text(start.projectId),
      directory: text(start.directory),
      resumeRunId: text(start.resumeRunId),
      provider: start.provider,
      model: start.model,
      deliverable: start.deliverable,
      pipeline: start.pipeline,
      inputs: start.inputs,
      experience: start.experience,
      ...(start.fixCi === true ? { fixCi: true } : {}),
    },
  };
}

/**
 * A worktree record off disk, or null.
 *
 * Every field must be there and be a string: the path is handed to
 * `git worktree remove` and the branch to `git branch -D`, so a half-written
 * record is not repaired into a usable one — it is read as "this run has no
 * worktree", which is the behaviour of every record written before the field.
 */
function parseRunWorktree(raw: unknown): RunWorktree | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<RunWorktree>;
  if (typeof w.path !== "string" || !path.isAbsolute(w.path)) return null;
  if (typeof w.branch !== "string" || !w.branch) return null;
  if (typeof w.base !== "string" || !w.base) return null;
  if (typeof w.project !== "string" || !path.isAbsolute(w.project)) return null;
  return {
    path: w.path,
    branch: w.branch,
    base: w.base,
    project: w.project,
    removed: w.removed === true,
    branchRemoved: w.branchRemoved === true,
    result: parseWorktreeResult((raw as { result?: unknown }).result),
  };
}

/** Every blocker this box words a next step for; anything else off disk is not one. */
const MERGE_HOME_BLOCKERS: readonly MergeHomeBlocker[] = ["not_on_base", "dirty", "conflict", "failed"];

/**
 * The merge verdict off disk, or null.
 *
 * Strict in the same way `parseRunWorktree` is, and for a sharper reason: the
 * card branches on this to decide whether to tell the owner their work is home
 * or offer to bring it home. A half-written record must read as "nothing was
 * decided" (the pre-field behaviour, where the card falls back to the general
 * sentence) rather than as a claim in either direction — so an `unmerged`
 * whose reason is not one this box knows is no verdict at all.
 */
function parseWorktreeResult(raw: unknown): RunWorktreeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RunWorktreeResult>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (r.kind === "merged") {
    return { kind: "merged", reason: null, detail: null, base: str(r.base), commit: str(r.commit) };
  }
  if (r.kind !== "unmerged") return null;
  const reason = MERGE_HOME_BLOCKERS.find((b) => b === r.reason);
  if (!reason) return null;
  return { kind: "unmerged", reason, detail: str(r.detail), base: null, commit: null };
}

/**
 * The PROJECT a run belongs to — the folder the owner knows, not the copy the
 * run works in.
 *
 * One reader for the whole codebase, because `run.directory` answered that
 * question everywhere until a run could have a worktree, and a surface that
 * kept asking it would file every run under a folder named after the run.
 */
export function projectDirectoryOf(run: Pick<CodingRun, "directory" | "worktree">): string {
  return run.worktree?.project ?? run.directory;
}

function normalizeMedia(raw: unknown): RunMedia {
  const value = (raw ?? {}) as Partial<RunMedia>;
  return { images: value.images === true, audio: value.audio === true };
}

function countOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * What the runs file looks like from outside, so a writer can tell whether it
 * is still the file it read. Null when there is none. The inode is in it
 * because every write lands through a rename: a file replaced between two
 * writes with the same size in the same millisecond is still a different file.
 */
function fileSignature(): string | null {
  try {
    const stat = fs.statSync(RUNS_PATH);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function readAll(): CodingRun[] {
  try {
    if (!fs.existsSync(RUNS_PATH)) {
      store.signature = null;
      return [];
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(RUNS_PATH, "utf-8"));
    store.signature = fileSignature();
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCodingRun).map(normalizeRun);
  } catch {
    // A corrupt file must not take the feature down; the next write repairs it.
    store.signature = null;
    return [];
  }
}

/**
 * Never write a run that is still going over one the file already says is
 * FINISHED.
 *
 * The store above is what makes this process agree with itself; this is the
 * floor under it, for a writer that is not this process at all. The module has
 * always known there can be one — a script, a test worker, a second server
 * during a restart — and the cost of losing the argument is not a stale read
 * but a destroyed record: the rig watched `completed` + its commit go back to
 * `running` + null on disk, after which the next boot settled a finished run as
 * lost and offered to start it again over work that was already merged.
 *
 * Only that one direction, and only for a run BOTH lists know about. A record
 * this process has settled and the file has not is the ordinary case and must
 * win; a record the file has and this list has not was deliberately dropped
 * (clearFinishedRuns) and stays dropped. `isSettled` and not `!isLive`: a
 * paused run or a draft is held, not finished, and both legitimately go back to
 * running.
 */
function keepSettledRecords(list: CodingRun[]): void {
  const onDisk = new Map(readAll().map((r) => [r.id, r]));
  for (const mine of list) {
    if (!isLive(mine.status)) continue;
    const theirs = onDisk.get(mine.id);
    if (!theirs || !isSettled(theirs.status)) continue;
    console.error(
      `[coding-agent] ${mine.id} is recorded as ${theirs.status} on disk; keeping that over this process's "${mine.status}"`,
    );
    // Over the record IN PLACE rather than replacing it in the array: the
    // repair has to reach every reader here, not just the bytes on their way
    // out, and `live` and a settle already in flight hold this very object. A
    // fresh one swapped into the array would leave them mutating an orphan.
    // Nothing in `live` is torn down — if this process really is driving that
    // run, its own settle writes the truth over this next.
    Object.assign(mine, theirs);
  }
}

function writeAll(list: CodingRun[]): void {
  // Cheap (one stat) and only ever true when a second writer exists, which on
  // a healthy box is never — see keepSettledRecords.
  if (store.signature !== null && fileSignature() !== store.signature) keepSettledRecords(list);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = untraced(`${RUNS_PATH}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not lose the run record
  }
  fs.renameSync(tmp, RUNS_PATH);
  store.signature = fileSignature();
}

/** What a spawn needs off the disk, resolved once before the record flips to running. */
interface SpawnTools {
  /** The capability-dropping binary. A run never starts without it. */
  setprivPath: string;
  /**
   * Absolute `systemd-run`, or null when this box cannot put a run in a scope
   * of its own. Null means the run is an ordinary child again and dies with the
   * web server — see readiness.detachedRuns.
   */
  scopePath: string | null;
}

/** The tail of a run's stream log, and where this process has read up to. */
interface StreamFollower {
  path: string;
  /** Bytes consumed. Mirrored onto the record as `streamOffset` for the next server. */
  offset: number;
  /** A line that arrived without its newline yet. */
  buffer: string;
  /** So a multi-byte character split across two reads is not mangled. */
  decoder: StringDecoder;
}

interface LiveRun {
  /**
   * The process, when THIS server spawned it. Null for a run this server
   * REATTACHED to after a restart: that process belongs to init now, its pipes
   * died with the server that opened them, and its scope and its process group
   * are the only handles left on it.
   */
  child: ChildProcess | null;
  /** The scope the run lives in, or null when it is a plain child. */
  unit: string | null;
  /** The process group — the only way to signal a reattached run. */
  pgid: number | null;
  /** The stream log being tailed. Null only if the log could not be opened. */
  stream: StreamFollower | null;
  /** Reads the tail of the stream log while the run works. */
  streamTimer: NodeJS.Timeout | null;
  /** Asks the scope whether a REATTACHED run is still there — it has no `exit` event. */
  unitWatch: NodeJS.Timeout | null;
  /** Where the harness's stderr is, so the settle can quote its last words. */
  stderrPath: string | null;
  /**
   * systemd turned this spawn away, so the harness never ran. Makes the one
   * automatic retry apply (directly, with no scope) and is what tells readiness.
   */
  scopeRefused: boolean;
  /**
   * This spawn was given `--input-format stream-json`, so its stdin stays open
   * and a message queued while it works can be written as the next user turn.
   * False for a plain spawn, and for a run this server only REATTACHED to —
   * that process's pipes died with the server that opened them, so its queue
   * can only be delivered at the next attempt or resume.
   */
  streamInput: boolean;
  /** Whether this process still holds the harness's stdin open. */
  stdinOpen: boolean;
  /**
   * The spawn has its inbox hook (CodingRun.midTurn): a message posted to its
   * inbox is handed to the model after the tool call it is in.
   */
  midTurn: boolean;
  /**
   * A turn is under way, so the hook will run again: from the spawn to its
   * result event, and again from a next turn written on stdin. A message sent
   * outside one goes the next-turn or next-start way instead.
   */
  turnOpen: boolean;
  /** Message ids this process put in the run's inbox and has no receipt for yet — what the tail looks for. */
  inboxPosted: Set<string>;
  /**
   * The harness turned `--input-format stream-json` away before it ever spoke.
   * Makes the one automatic retry apply — running plain, which is the whole
   * difference — the way `scopeRefused` does for a scope systemd refused.
   */
  streamInputRefused: boolean;
  /**
   * This run was found alive-on-paper but its scope was gone: the box restarted
   * while it worked. Read by finishRun, which would otherwise report the
   * harness's silence as a crash of the harness.
   */
  lostToRestart: boolean;
  /** Rolling idle check — see RUN_IDLE_TIMEOUT_MS. */
  timeout: NodeJS.Timeout;
  killTimer: NodeJS.Timeout | null;
  /**
   * What the owner (or the token ceiling) asked this run to do: end for good,
   * or settle as paused with its session intact for resumeRun(). One field,
   * not two flags, because the two gestures are exclusive and the later
   * Stop overrides an earlier Pause — see requestEnd.
   */
  endRequested: "stop" | "pause" | null;
  /**
   * The last time one of this box's meters refused THIS run, as the far side
   * worded it — the evidence a later pause is read against.
   *
   * It lives here, on the live process, rather than on the record: the routes
   * that learn of a refusal (the media routes) know the run and the code, and
   * `pauseRun` — whose only caller is the pause route — knows neither. Nothing
   * else can write it, so nothing else can claim a pause it did not cause.
   *
   * Consumed by the first pause inside PAUSE_AFTER_REFUSAL_MS and cleared the
   * moment the same meter produces a file, so a spent-then-recovered meter
   * cannot explain a pause it is no longer the reason for.
   */
  allowanceRefusal: { meter: CodingPauseMeter; resetsAt: string | null; message: string; at: number } | null;
  /**
   * Why this run was asked to pause, decided when the pause was ASKED for
   * rather than when the process finally exits.
   *
   * The gap between the two is a graceful shutdown — seconds of it — and the
   * refusal that explains the pause is only fresh at the near end of that gap.
   * Null until a pause is requested; see requestEnd and finishRun.
   */
  pauseReason: CodingPauseReason | null;
  timedOut: boolean;
  sawResult: boolean;
  /** The first init has been seen; any later one is the CLI continuing. */
  sawInit: boolean;
  /** Whether "Thinking…" has already been said once. */
  sawThinking: boolean;
  /**
   * A Codex run's last agent message — its closing words once the turn
   * completes — and the last notice the CLI printed (a retry, a stream error),
   * which is the best account of a run that ends with no verdict at all.
   */
  codexLastMessage?: string | null;
  codexNotice?: string | null;
  /** A Codex run's usage limit or refused credential, in the CLI's words. */
  codexLimit?: string | null;
  codexAuth?: string | null;
  /** What the thread had already billed before this spawn — see codexUsageBaseline. */
  codexBaseline?: CodexThreadUsage;
  /** The last thinking_tokens figure seen, to tell "more of this block"
   *  (add the difference) from "a new block began" (add it all). */
  thinkingSeen: number;
  stderr: string;
  /**
   * Files a Write/Edit has ASKED for, by tool_use id, not yet confirmed.
   *
   * A real run reported /tmp/check_html.py among its changed files when the
   * write had in fact been refused: the list was built from what the model
   * asked to do, and a request is not an outcome. Nothing lands in
   * filesTouched now until the tool_result comes back without an error.
   */
  pendingFiles: Map<string, string>;
  /**
   * File tools a run in a worktree aimed at the project's own path, by
   * tool_use id: the tool, and the same path in the worktree
   * (`worktreeHintFor`). A refusal of one is answered with a retry hint.
   */
  worktreeTargets: Map<string, { tool: string; counterpart: string }>;
  /** Worktree paths this spawn has already hinted: each is said once. */
  worktreeHinted: Set<string>;
  /**
   * Whether the run ever ASKED to write, confirmed or not.
   *
   * filesTouched holds only confirmed writes, which is right for reporting and
   * wrong for the retry gate: a run killed between the request and its result
   * may have written the file anyway, and a retry would then start from a
   * half-finished edit. Reporting takes the strict answer, the gate takes the
   * cautious one.
   */
  sawWriteAttempt: boolean;
  /**
   * Whether a model has actually answered this spawn: a real assistant
   * message, main loop or helper, not one the CLI wrote itself ("<synthetic>")
   * to carry an API error. With `run.tokensUsed`, what tells a model error
   * in the middle of a run from a harness that never got a model to answer —
   * only the second is recorded as a harness fault (TASK-1320).
   */
  sawModelAnswer: boolean;
  /**
   * `run.tokensUsed` when this spawn began, so the verdict above counts what
   * THIS spawn was billed. The record's bill alone would not do: a resume, an
   * account switch and a pipeline lap all continue a record that already
   * carries earlier spawns' tokens, and a resumed spawn refused on its very
   * first request is the startup case again, not a model error mid-run. The
   * automatic retry inherits its first attempt's value — one run making a
   * second try seconds later, at the same work.
   */
  tokensAtSpawn: number;
  /** `run.tokenBreakdown` when this process began: the CLI's modelUsage counts from zero per process. */
  breakdownAtSpawn: TokenBreakdown;
  /**
   * This process continues an earlier session (`--resume`): a review pass, a
   * completion attempt, the owner's Resume. Its CLI reports modelUsage for the
   * WHOLE session, history included (measured 2026-10-18: a review pass's
   * record read 270,596 = the run's own 125,100 + its 145,496), so the
   * raise-to-modelUsage below would bill the earlier spawns again. Such a
   * process is billed from its own assistant events only.
   */
  resumedSession?: boolean;
  /**
   * tool_use ids of sub-agents that have started and not yet reported back.
   * Ids rather than a counter: a tool_result can arrive out of order, and a
   * duplicate must not decrement twice.
   */
  openSubagents: Map<string, ActiveSubagent>;
  /**
   * The API message billed last. The CLI streams one assistant event per
   * content block of a message, every one carrying the message's full usage
   * (measured on 2.1.259: thinking block, then the text or tool_use block,
   * identical usage on both) — billed per event, a turn cost double and the
   * owner's ceiling tripped at half its number. Per-message billing sums to
   * exactly the CLI's own modelUsage. A bounded set rather than the last id
   * alone: two helpers working at once interleave their events.
   */
  billedMessageIds: Set<string>;
  /**
   * Output tokens the assistant events of the current CLI segment reported.
   * Through the ClawBox AI proxy every assistant event says output_tokens 0
   * and the real number arrives only on the segment's result event (574 and
   * 9 in the probe), so the result bills the difference — and never twice on
   * a backend whose assistant events do carry it.
   */
  outputBilledInSegment: number;
  /** tool_use id → tokens already billed for that workflow, from its
   *  task_progress reports (cumulative totals; only the delta is billed). */
  helperBilled: Map<string, number>;
  /** Resolved once at start, so a retry does not need an async lookup. */
  tools: SpawnTools;
  /** What this run was spawned with — a retry must match, not re-read. */
  settings: { effort: CodingEffort; maxTurns: number };
  /** A shell command ran whose effects can be proven neither read-only nor safe to repeat. */
  commandMayHaveSideEffects: boolean;
  /**
   * The final result event's verdict, applied only when the process exits.
   *
   * A result event is USUALLY the stream's last word, but a resumed session
   * has been seen to emit a result-shaped event while the process kept
   * working (run-qqj1io65 showed "completed" mid-run, then worked three more
   * minutes). The process being gone is the only proof the run is over, so
   * finishRun applies this rather than the stream handler.
   */
  outcome: { status: "completed" | "failed"; error: string | null; resumable: boolean } | null;
  /**
   * The HARNESS's own report that the Anthropic account ran into its cap — the
   * synthetic assistant message the CLI writes instead of an answer (TASK-902).
   * The settle path reads this before the run's closing words, because those
   * are the run's and a run can be writing ABOUT limits.
   */
  limitSignal: string | null;
  /**
   * The owner's test hook (`simulateAnthropicLimit`): the words of a limit to
   * settle this run with, set just before the hook ends the process.
   */
  simulatedLimit: string | null;
  /**
   * A pause the account switch decided on after the process had gone — no
   * other account could take the run over — applied when finishRun runs again.
   */
  forcedAccountPause: { resetsAt: string | null; message: string } | null;
  /**
   * The HARNESS's own report that Anthropic refused the account's credential
   * (TASK-1260) — a synthetic message tagged `authentication_failed`, or one
   * that reads as a 401. Like `limitSignal`, read before the run's own words.
   */
  authSignal: string | null;
  /**
   * The box's active account moved off the account this run is on, and the
   * swap ended the process to carry the run on on the new one (TASK-1260).
   */
  accountMove: boolean;
  /**
   * A failure the account handling decided on after the process had gone — a
   * refused credential with no account left to move to — applied when
   * finishRun runs again.
   */
  forcedAccountFailure: string | null;
}

/**
 * Everything about the runs that must not exist twice.
 *
 * WHY IT IS NOT PLAIN MODULE STATE. Next compiles the boot hook
 * (src/instrumentation.ts) in a layer of its own, so its
 * `require("./lib/coding-agent")` and a route handler's
 * `import "@/lib/coding-agent"` are two DIFFERENT modules inside the one
 * web-server process — proved off the production build, see
 * src/lib/process-store.ts. With the state per module copy, the two halves of
 * this file's job came apart exactly where a restart put them:
 *
 *   - the boot hook REATTACHES a run that survived the restart and settles it
 *     on its own copy, while the routes' copy froze whatever the file said at
 *     the moment the first GET populated it — and the Coding Agent window polls
 *     every 5 s, so on the rig (2026-09-13, 2 boards, 2/2) that was always
 *     mid-run. The record answered `running`, `commit: null` for ever, and the
 *     phantom cost a parallel slot: `maxParallelRuns: 1` then refused every new
 *     run;
 *   - and that copy's next write — an unrelated run being started — put the
 *     older snapshot back over the settled record on disk (`completed` + commit
 *     → `running` + null, read straight off data/coding-agent-runs.json), so
 *     the next restart settled a finished run as "the box restarted while the
 *     run was live" over work that was already merged.
 *
 * Keyed by the runs file, because that is what the state is a cache OF: two
 * copies pointing at one file share one store, and a test with its own
 * CLAWBOX_ROOT gets its own.
 *
 * `liveHarnessFault` is deliberately NOT here: it is a synchronous shadow of a
 * value that lives in the config store, so a second copy of this module reads
 * it off disk rather than missing it.
 */
interface RunStore {
  /** Newest first. `null` until first use. */
  runs: CodingRun[] | null;
  live: Map<string, LiveRun>;
  waiters: Map<string, Set<() => void>>;
  flushTimer: NodeJS.Timeout | null;
  /** When `flushTimer` is due, so a later persist can only bring it forward. Optional: a store from an older module. */
  flushDueAt?: number | null;
  dirty: boolean;
  exitHookInstalled: boolean;
  /** A run's injected secrets, kept off the record — see runSecretEnv. */
  runSecretEnv: Map<string, Record<string, string>>;
  /** Which scope each of those came from, names only — see runSecretScopes. Optional: a store from an older module. */
  runSecretScopes?: Map<string, Record<string, string>>;
  /** When each dated one of those stops being handed — see runSecretExpiry. Optional: a store from an older module. */
  runSecretExpiry?: Map<string, Record<string, number>>;
  /** The Anthropic account a run's next spawn uses, credential included — see runAnthropicCredential. */
  runAnthropicCredential: Map<string, RunAnthropicCredential>;
  /** The MCP servers a run's project opted into, credentials included — see runMcpPlan. */
  runMcpPlan: Map<string, RunMcpPlan>;
  /** An `openai` run's API key — see runOpenAIKey. Optional: a store from an older module. */
  runOpenAIKey?: Map<string, string>;
  /** The runs whose pull request or review is already being watched. */
  prWatchers: Set<string>;
  reviewWatchers: Set<string>;
  /** Settle chains a test can wait on — see trackSettleWork. */
  settling: Set<Promise<void>>;
  /** Runs whose record says settled while their commit is still being made — see waitForRun. */
  unannounced: Set<string>;
  /** One lifecycle change at a time per run — see transitions. */
  transitions: Map<string, Promise<CodingRun>>;
  /** One pipeline advance at a time per run — see advancePipeline. */
  pipelineAdvancing: Map<string, Promise<void>>;
  /** Starts past the gate and not yet visible to loadRuns() — see startingRuns. */
  startingRuns: number;
  /** The same, for automatic review passes — their own pool. */
  startingReviews: number;
  /** Of `startingRuns`, the ones that are a team's, by team id — see judgeTeamSlot. Made on first use. */
  startingTeams?: Map<string, number>;
  /**
   * The runs file as this process last read or wrote it. A file that has moved
   * on since means somebody else writes it too; writeAll() checks rather than
   * trusting its own snapshot.
   */
  signature: string | null;
  /** The runs are registered as a consumer of the box's active Anthropic account (TASK-1260). */
  swapConsumerArmed?: boolean;
  /** The pass resuming the runs that waited for an Anthropic reset — one at a time. */
  anthropicResume?: Promise<string[]>;
  /** How many times each run was carried on after a refused credential — see MAX_AUTH_SWITCHES. */
  anthropicAuthRetries?: Map<string, number>;
  /** The owner's history setting as last read — see rememberHistoryPolicy. */
  historyPolicy: HistoryPolicy | null;
  /** The run queue's pass in flight, and whether a slot freed while it ran — see pumpRunQueue. */
  queuePump?: Promise<string[]>;
  queuePumpAgain?: boolean;
  /** The queue's next look when it stopped for something that clears by itself (the switch, readiness). */
  queueRetry?: NodeJS.Timeout | null;
}

const store = processStore<RunStore>(RUNS_PATH, () => ({
  runs: null,
  live: new Map<string, LiveRun>(),
  waiters: new Map<string, Set<() => void>>(),
  flushTimer: null,
  dirty: false,
  exitHookInstalled: false,
  runSecretEnv: new Map<string, Record<string, string>>(),
  runAnthropicCredential: new Map<string, RunAnthropicCredential>(),
  runMcpPlan: new Map<string, RunMcpPlan>(),
  prWatchers: new Set<string>(),
  reviewWatchers: new Set<string>(),
  settling: new Set<Promise<void>>(),
  unannounced: new Set<string>(),
  transitions: new Map<string, Promise<CodingRun>>(),
  pipelineAdvancing: new Map<string, Promise<void>>(),
  startingRuns: 0,
  startingReviews: 0,
  signature: null,
  historyPolicy: null,
}));

const live = store.live;
const waiters = store.waiters;

/**
 * Load the store. READ-ONLY on purpose: settling stale records lives in
 * reconcileAfterRestart(), called from the boot hook of the ONE process that
 * owns runs. When the settle lived here, any other process that imported this
 * module against the real root — a test worker, a script — would take a run
 * the live web server was still driving for a dead server's leftover and
 * stamp it failed on disk (measured on this box: run-0nxtbhb1, 2026-08-27).
 */
function loadRuns(): CodingRun[] {
  if (store.runs) return store.runs;
  store.runs = readAll();
  return store.runs;
}

/** What a run lost to a restart is told, when nothing in its log says otherwise. */
const LOST_TO_RESTART = "The box restarted while the run was live, so it did not finish. Start it again.";

/**
 * What the previous web server left behind, from the boot hook
 * (src/instrumentation.ts) — before anyone asks. Returns how many runs were
 * SETTLED, which is the one signal an operator gets that a restart killed work.
 *
 * Three outcomes per record that says "running", because a run is no longer
 * necessarily dead just because the server that started it is:
 *
 *  - its scope is still ACTIVE: the run survived, and this server REATTACHES —
 *    it picks the stream log up at the byte the last server had read and watches
 *    the unit for the exit it can no longer be told about. Nothing is settled.
 *  - its scope is gone but the log has the harness's own closing result: the run
 *    finished while nobody was watching, and it settles as what it said it was.
 *  - anything else: the box restarted while it was live, and it says so.
 *
 * A record with no unit at all — a plain child of the old server, or a run from
 * before this existed — can only ever be the third.
 */
export async function reconcileAfterRestart(): Promise<number> {
  // What a server that died mid-run left of its runs' MCP config files: each
  // was read by its harness at start, and its credentials are not left lying
  // about for the next settle to maybe find.
  sweepRunMcpConfigs();
  const list = loadRuns();
  let repaired = 0;
  let changed = false;
  // Resolved once for the whole sweep rather than per run: a reattached run that
  // fails transiently may still take its one automatic retry, and that retry
  // needs the same two tools a fresh spawn does.
  const tools: SpawnTools = await reattachTools();
  for (const run of list) {
    const orphaned = run.status === "running" && !live.has(run.id);
    // Only a run that HAS a unit is asked about, which on a settled record means
    // only one that recorded a leftover (every other settle forgets its unit),
    // so this is a handful of systemctl calls at boot and usually none.
    //
    // A `null` answer — systemd could not be asked — counts as gone HERE, and
    // deliberately not in the reattach watch. The difference is what else can be
    // trusted: this process has held no handle on the run, so the recorded pid
    // may since have been given to a stranger and cannot second the answer,
    // while a reattach has already seen the scope alive with that pid in it. A
    // record left "running" that nothing will ever settle is the worse outcome.
    const unitStillUp = run.unit !== null && (await unitActive(run.unit)) === true;
    if (orphaned && unitStillUp) {
      // ALIVE. Its pgid and its unit are still the real handles on it, so
      // neither is forgotten below.
      reattach(run, tools);
      pushProgress(run, RUNNER_STEP.reattached);
      changed = true;
      continue;
    }
    if (unitStillUp) {
      // SETTLED, and its scope is still up — so something it left is still in
      // that cgroup. A unit name, unlike a pid, is never handed to anybody else,
      // so the Kill button still names exactly what it named before the restart:
      // the unit is kept and only the pid is forgotten.
      if (run.pgid !== null) {
        run.pgid = null;
        changed = true;
      }
      if (!run.leftover) {
        run.leftover = true;
        changed = true;
      }
      continue;
    }
    // A recorded process group belonged to a cgroup this restart replaced, so
    // whatever it named is gone — and Linux is free to hand that number to
    // something else, which the Kill button would then signal in this run's
    // name. Forgetting it costs nothing: `spawnRun` records a fresh group, and
    // an offer to end a process nobody can still identify is worse than no
    // offer at all.
    if (run.pgid !== null || run.unit !== null || run.leftover) {
      run.pgid = null;
      run.unit = null;
      run.leftover = false;
      changed = true;
    }
    if (orphaned) {
      settleLostRun(run, tools);
      repaired += 1;
      changed = true;
    }
  }
  if (changed) {
    try {
      writeAll(list);
    } catch (err) {
      console.error("[coding-agent] could not repair the runs file:", err instanceof Error ? err.message : err);
    }
  }
  return repaired;
}

/** setpriv and systemd-run for the boot sweep — best effort, never a reason to refuse it. */
async function reattachTools(): Promise<SpawnTools> {
  const [setprivPath, scope] = await Promise.all([
    findExecutableOnPath(CAPABILITY_DROP_COMMAND),
    probeSystemdRun(),
  ]);
  // An empty setpriv path is not a hole in the capability fence: it never
  // reaches argv, because the only spawn that could use it — the one automatic
  // retry — fails at `spawn` and is reported as "Retry could not start".
  return { setprivPath: setprivPath ?? "", scopePath: scope.available ? scope.path : null };
}

/** The minimum LiveRun for a run this process did not spawn. */
function detachedState(run: CodingRun, tools: SpawnTools, lostToRestart: boolean): LiveRun {
  const state: LiveRun = {
    child: null,
    unit: run.unit,
    pgid: run.pgid,
    stream: null,
    streamTimer: null,
    unitWatch: null,
    stderrPath: null,
    scopeRefused: false,
    // The pipes died with the server that opened them — but not its hook: a
    // reattached run with an inbox still takes a message mid-turn, and what
    // was waiting in it when the last server went is still looked for.
    streamInput: false,
    stdinOpen: false,
    midTurn: run.midTurn === true,
    turnOpen: true,
    inboxPosted: new Set<string>(run.midTurn === true ? safeInboxPending(run.id) : []),
    streamInputRefused: false,
    lostToRestart,
    openSubagents: new Map<string, ActiveSubagent>(),
    billedMessageIds: new Set<string>(),
    outputBilledInSegment: 0,
    helperBilled: new Map<string, number>(),
    pendingFiles: new Map<string, string>(),
    worktreeTargets: new Map<string, { tool: string; counterpart: string }>(),
    worktreeHinted: new Set<string>(),
    sawWriteAttempt: false,
    // What the process saw before the restart is gone with it; the record's
    // `tokensUsed` still speaks for any answer it got, so all of it counts —
    // the process being reattached is the spawn that billed it.
    sawModelAnswer: false,
    tokensAtSpawn: 0,
    breakdownAtSpawn: { ...run.tokenBreakdown },
    sawThinking: false,
    thinkingSeen: 0,
    ...(runsOnCodex(run.provider) ? { codexBaseline: codexUsageBaseline(run.sessionId) } : {}),
    tools,
    settings: { effort: run.effort, maxTurns: run.maxTurns },
    commandMayHaveSideEffects: false,
    timeout: setInterval(() => {
      const idleFor = Date.now() - run.lastActivityAt;
      if (idleFor < RUN_IDLE_TIMEOUT_MS) return;
      state.timedOut = true;
      endProcess(state);
    }, IDLE_CHECK_MS),
    killTimer: null,
    endRequested: null,
    allowanceRefusal: null,
    pauseReason: null,
    limitSignal: null,
    simulatedLimit: null,
    forcedAccountPause: null,
    authSignal: null,
    accountMove: false,
    forcedAccountFailure: null,
    timedOut: false,
    // The harness's segment carries on across the restart, and the result it
    // eventually prints reports that whole segment's totals — which is exactly
    // what a first result event is applied as.
    sawResult: false,
    sawInit: false,
    outcome: null,
    stderr: "",
  };
  state.timeout.unref();
  return state;
}

/**
 * Take a surviving run back over: follow its log from where the last server got
 * to, and watch its scope for the end.
 *
 * There is no child object and never will be one — the process was reparented to
 * init when its server died — so the unit is the only thing that can say the run
 * is over. When systemd cannot be asked at all, the recorded process group is
 * the fallback question: "we could not look" must never be read as "it is gone",
 * or a bus hiccup would settle a working run as lost.
 */
function reattach(run: CodingRun, tools: SpawnTools): void {
  // The idle clock starts HERE, not at whatever the previous server last saw.
  // `detachedState` arms the watchdog against `lastActivityAt`, and a run that
  // outlived a restart longer than RUN_IDLE_TIMEOUT_MS would be judged idle on
  // its first check — killed about a minute after boot, with "no sign of life"
  // on the record — while it was working perfectly well. This process saw
  // nothing during the gap, so it may not hold the run to that silence; the
  // tail (`followStream`) is what moves the clock from now on.
  run.lastActivityAt = Date.now();
  const state = detachedState(run, tools, false);
  live.set(run.id, state);
  followStream(run, state);
  // What its hook handed over while no server was watching.
  collectInboxReceipts(run, state);
  installExitHook();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    drainForSettle(run, state);
    // No exit code: the process was not ours to wait on. Whatever the harness
    // printed before it went is what the record is settled from.
    finishRun(run, state, null);
  };
  state.unitWatch = setInterval(() => {
    void (async () => {
      if (settled) return;
      // The HARNESS's own process first, because the SCOPE is not the same
      // question: a run that deliberately left a server listening — the pattern
      // the orientation guide documents — keeps its cgroup alive after it has
      // finished, and waiting for the cgroup would leave a settled run showing
      // "running" until the idle timeout killed it and the server with it.
      if (state.pgid !== null && !processAlive(state.pgid)) {
        settle();
        return;
      }
      const active = run.unit ? await unitActive(run.unit) : false;
      if (active === true) return;
      // "Could not be asked" is not "gone": the process group is the second
      // opinion, so a wedged user bus cannot settle a working run as lost.
      if (active === null && groupAlive(state.pgid)) return;
      settle();
    })().catch(() => {});
  }, UNIT_POLL_MS);
  state.unitWatch.unref();
  console.error(`[coding-agent] ${run.id} reattached to ${run.unit}`);
}

/**
 * A run that was live and whose scope has gone.
 *
 * Its log is read to the end FIRST, because a run whose scope outlived the web
 * server may well have finished properly while nothing was watching — and a
 * closing result event in the log is the box's only record of that. Only when
 * there is none is the restart reported as what ended it.
 */
function settleLostRun(run: CodingRun, tools: SpawnTools): void {
  const state = detachedState(run, tools, true);
  // Whatever it named is gone with the cgroup, so nothing here may be signalled.
  state.pgid = null;
  state.unit = null;
  live.set(run.id, state);
  state.stream = { path: streamLogPath(run.id), offset: run.streamOffset, buffer: "", decoder: new StringDecoder("utf8") };
  state.stderrPath = stderrLogPath(run.id);
  drainForSettle(run, state);
  finishRun(run, state, null);
}

function persist(immediate = false, delayMs: number = FLUSH_INTERVAL_MS): void {
  const list = loadRuns();
  if (immediate) {
    store.dirty = false;
    if (store.flushTimer) {
      clearTimeout(store.flushTimer);
      store.flushTimer = null;
    }
    store.flushDueAt = null;
    try {
      writeAll(list);
    } catch (err) {
      console.error("[coding-agent] could not write the runs file:", err instanceof Error ? err.message : err);
    }
    return;
  }
  store.dirty = true;
  const now = Date.now();
  const due = flushDeadline(store.flushDueAt ?? null, now, delayMs);
  if (store.flushTimer && (store.flushDueAt ?? Infinity) <= due) return;
  if (store.flushTimer) {
    // A nearer deadline than the one already scheduled: bring the flush
    // forward rather than wait out the longer window.
    clearTimeout(store.flushTimer);
    store.flushTimer = null;
  }
  store.flushDueAt = due;
  const timer = setTimeout(() => {
    store.flushTimer = null;
    store.flushDueAt = null;
    if (!store.dirty) return;
    store.dirty = false;
    try {
      writeAll(loadRuns());
    } catch (err) {
      console.error("[coding-agent] could not write the runs file:", err instanceof Error ? err.message : err);
    }
  }, Math.max(0, due - now));
  timer.unref();
  store.flushTimer = timer;
}

function cloneRun(run: CodingRun): CodingRun {
  const clone: CodingRun = {
    ...run,
    workflowTelemetry: cachedWorkflowTelemetry(transcriptPath(run), run.startedAt, run.completedAt),
    filesTouched: [...run.filesTouched],
    progress: [...run.progress],
    progressAt: [...run.progressAt],
    tokenBreakdown: { ...run.tokenBreakdown },
    spawnTokens: [...run.spawnTokens],
    deniedActions: [...run.deniedActions],
    denials: run.denials.map((d) => ({ ...d })),
    allowRules: [...run.allowRules],
    // Nested, so it needs its own copy: a route holding a clone must not be
    // able to write the staged list the record keeps.
    inputs: run.inputs
      ? { dir: run.inputs.dir, shared: run.inputs.shared, files: run.inputs.files.map((f) => ({ ...f })), refused: run.inputs.refused.map((r) => ({ ...r })) }
      : null,
    secretNames: [...run.secretNames],
    activeSubagents: run.activeSubagents.map((a) => ({ ...a })),
    subagents: run.subagents.map((a) => ({ ...a })),
    subagentsByType: { ...run.subagentsByType },
    modelsUsed: [...run.modelsUsed],
    todos: run.todos.map((t) => ({ ...t })),
    // Nested, so it needs its own copy: a shared object here would let a route
    // holding a clone see the watcher's later writes — and mutate them.
    pr: run.pr ? { ...run.pr, checks: { ...run.pr.checks } } : null,
    // Nested for the same reason `pr` is: a route holding a clone must not see
    // — or be able to write — the loop's own later rounds.
    review: run.review ? { ...run.review, checks: run.review.checks.map((c) => ({ ...c })) } : null,
    pauseReason: run.pauseReason ? { ...run.pauseReason } : null,
    // Copied entry by entry: a route holding a clone must not be able to mark
    // a message delivered that the harness has never seen.
    messages: run.messages.map((m) => ({ ...m })),
    // Nested two deep — steps, and the evidence under each — so a route holding
    // a clone can neither see nor write the driver's later stages.
    pipeline: run.pipeline ? clonePipeline(run.pipeline) : null,
    experience: run.experience ? { ...run.experience, ruleIds: [...run.experience.ruleIds] } : null,
    // Where it stands, never what it asked for: the request (inputs, an
    // experience block) is the runner's to start it with, not a reader's.
    queued: run.queued ? { at: run.queued.at, position: queuePosition(run.id) ?? undefined } : null,
    ci: run.ci ? { ...run.ci, checks: [...run.ci.checks], tests: [...run.ci.tests], files: [...run.ci.files], unread: [...run.ci.unread] } : null,
    ciFixOf: run.ciFixOf ? { ...run.ciFixOf } : null,
  };
  // The experience block is left out, not copied: it is for the next spawn,
  // which reads the record itself — see CodingRun.experienceBrief.
  delete clone.experienceBrief;
  return clone;
}

export function getRun(id: string): CodingRun | null {
  const run = loadRuns().find((r) => r.id === id);
  if (run) return cloneRun(run);
  // An older run a history mode kept past the live thirty: its own file, read
  // on demand. Settled by construction — nothing held ever leaves the list.
  const older = readOlderRun(id);
  return older ? cloneRun(older) : null;
}

export function listRuns(limit = MAX_RUNS_KEPT): CodingRun[] {
  return loadRuns().slice(0, Math.max(0, limit)).map(cloneRun);
}

/** An older run's record off its own file, normalised like the runs file's, or null. */
function readOlderRun(id: string): CodingRun | null {
  if (!RUN_ID_RE.test(id) || !hasOlderRuns()) return null;
  const raw = readOlderRunRecord(id);
  return isCodingRun(raw) && raw.id === id ? normalizeRun(raw) : null;
}

/**
 * A page of the runs a history mode keeps past the live thirty, newest first,
 * and how many there are. `project` narrows it to one project folder (the
 * folder the owner knows — see projectDirectoryOf). Read from the older runs'
 * own files, so the runs file this whole module rewrites every second never
 * holds them.
 */
export function listOlderRuns(options: { offset?: number; limit?: number; project?: string | null } = {}): { runs: CodingRun[]; total: number } {
  if (!hasOlderRuns()) return { runs: [], total: 0 };
  const project = options.project ? path.resolve(options.project) : null;
  const index = olderRunIndex().filter((e) => !project || path.resolve(e.project || e.directory) === project || path.resolve(e.directory) === project);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(0, Math.floor(options.limit ?? MAX_RUNS_KEPT));
  const runs = index.slice(offset, offset + limit).flatMap((e) => {
    const run = readOlderRun(e.id);
    return run ? [cloneRun(run)] : [];
  });
  return { runs, total: index.length };
}

/** Everything the settings card says about the run history, in one read. */
export interface RunHistorySummary {
  mode: HistoryRetentionMode;
  limit: number;
  limits: number[];
  /** Runs the live list holds in every mode. */
  liveKept: number;
  counts: { live: number; older: number; archived: number };
  /** Null when the walk failed; the card then says it could not measure. */
  usage: HistoryUsage | null;
  disk: DiskSpace & { minFreeBytes: number; low: boolean };
  /** Claude Code's transcript period, per settings file the box's runs use. */
  transcripts: HarnessTranscriptState[];
}

/** The Claude Code folders a run's transcript lands in (both providers'). */
function harnessTranscriptDirs(): string[] {
  return [...new Set((["clawbox-ai", "anthropic"] as const).map((p) => path.join(harnessStateDir(p), "projects")))];
}

export async function runHistorySummary(): Promise<RunHistorySummary> {
  const policy = await getHistoryPolicy();
  const usage = await historyUsage({ runsFile: RUNS_PATH, streamsDir: STREAM_DIR, transcriptDirs: harnessTranscriptDirs() }).catch((err) => {
    console.error("[coding-agent] could not measure the run history:", err instanceof Error ? err.message : err);
    return null;
  });
  const disk = diskSpace();
  return {
    mode: policy.mode,
    limit: policy.limit,
    limits: [...HISTORY_EXTENDED_LIMITS],
    liveKept: MAX_RUNS_KEPT,
    counts: {
      live: loadRuns().length,
      older: hasOlderRuns() ? olderRunIndex().length : 0,
      archived: archiveIndex().length,
    },
    usage,
    disk: { ...disk, minFreeBytes: HISTORY_MIN_FREE_BYTES, low: isDiskLow(disk) },
    transcripts: harnessTranscriptState(harnessSettingsFiles()),
  };
}

/**
 * Every file of the run history, for "Export all history" — the live list,
 * the older runs, their evidence, inputs and transcripts, and the archive. See
 * historyExportSources for the layout inside the zip.
 */
export function historyExportAll(): AsyncGenerator<ZipSource> {
  const runs = loadRuns();
  const older = hasOlderRuns() ? olderRunIndex() : [];
  const policy = store.historyPolicy ?? STANDARD_HISTORY_POLICY;
  const transcripts = [
    ...runs.map((r) => ({ id: r.id, file: transcriptPath(r) })),
    ...older.map((e) => {
      const run = readOlderRun(e.id);
      return { id: e.id, file: run ? transcriptPath(run) : null };
    }),
  ];
  return historyExportSources({
    manifest: {
      kind: "clawbox-run-history",
      version: 1,
      exportedAt: new Date().toISOString(),
      retention: policy.mode,
      ...(policy.mode === "extended" ? { limit: policy.limit } : {}),
      runs: runs.length,
      olderRuns: older.length,
      archivedRuns: archiveIndex().length,
      layout: {
        "runs.json": "the runs listed on the box, newest first",
        "older-runs/<runId>.json": "runs kept past the newest thirty (Extended, Keep everything)",
        "evidence/<runId>/": "each run's evidence folder",
        "inputs/<runId>/": "the files each run was given",
        "transcripts/<runId>.jsonl": "Claude Code's transcript of the run, where it still exists",
        "archive/<runId>/": "archived runs: run.json, archive.json, evidence/, inputs/, transcript.jsonl, stream logs",
      },
    },
    // A snapshot now: the export streams for minutes, and these records are
    // the very objects the live runs keep writing to.
    runs: structuredClone(runs),
    transcripts,
  });
}

/**
 * Forget the finished runs. Returns how many were removed.
 *
 * A run still in flight is KEPT, whatever the caller asked for: it is the only
 * handle on a live process — the record the stop route looks up, and the one
 * the boot sweep settles if the server dies. Dropping it would leave a coding
 * agent working in a folder with nothing on the device that knows about it.
 *
 * Owner-only at the route, for the same reason the switch is: these records
 * are the account of what the assistant did with a delegated shell, and the
 * party they describe is not the party who should be able to erase them.
 */
export function clearFinishedRuns(policy: HistoryPolicy = store.historyPolicy ?? STANDARD_HISTORY_POLICY): number {
  const list = loadRuns();
  // Paused runs hold a resumable session and drafts never ran — neither is
  // "finished", so the owner's clear-history sweep leaves them alone. A run
  // whose pull request is still being watched is not finished either: it has
  // SETTLED, but deleting it would take its evidence folder and leave a
  // watcher polling a record that no longer exists.
  //
  // EXCEPT a paused run or a draft whose folder is GONE. resumeRun and
  // startDraftRun both refuse it ("start a new run instead"), so it can
  // neither go on nor finish, and kept here it was immortal: past the rail's
  // newest dozen it was listed nowhere (no folder, so no project row), and
  // no sweep touched it — the review pass paused in a folder the owner had
  // since deleted, 2026-09-06. A LIVE run is kept whatever its folder says:
  // the record is the only handle on the process.
  // `holdsResumableSession` covers `gave_up` as well as the held three, for the
  // reason written above: it holds a resumable session, so it is not "finished"
  // either. The folder exception applies to it unchanged — `resumeRun` refuses a
  // run whose folder is gone, so such a record can neither go on nor finish.
  const heldOn = (r: CodingRun) => holdsResumableSession(r.status) && (isLive(r.status) || folderPresent(r.directory));
  // ONE decision per run, used for both the record and its evidence folder:
  // judged twice, a folder that came or went between the two looks would
  // drop a record and keep its artifacts, or the other way round.
  const keep: CodingRun[] = [];
  const dropped: CodingRun[] = [];
  for (const r of list) (heldOn(r) || isPrPending(r.pr) ? keep : dropped).push(r);
  // The older runs a history mode kept are finished runs of this same list,
  // so the owner's Clear takes them too. Under archive they are ARCHIVED like
  // everything else leaving the list, which is what that mode promises.
  const older = hasOlderRuns() ? olderRunIndex() : [];
  const removed = dropped.length + older.length;
  if (removed === 0) return 0;
  const low = policy.mode === "archive" && isDiskLow(diskSpace());
  for (const r of dropped) dropRun(r, policy, "cleared", low);
  for (const e of older) dropOlderRun(e, policy, "cleared", low);
  // Mutate the array the module hands out rather than replacing the binding,
  // so every existing reader sees the same list.
  list.length = 0;
  list.push(...keep);
  persist(true);
  // The owner is looking at the figures this changes: a deleted evidence
  // folder must not be counted for another half-minute out of the cache.
  invalidateUsage();
  console.error(`[coding-agent] cleared ${removed} finished run(s) at the owner's request${policy.mode === "archive" && !low ? " into the archive" : ""}`);
  return removed;
}

export function runningCount(): number {
  return loadRuns().filter((r) => isLive(r.status)).length;
}

/** The run executing right now, or null. (The record itself, not a clone: internal.) */
function activeRun(): CodingRun | null {
  return loadRuns().find((r) => isLive(r.status)) ?? null;
}

/**
 * The working folder of the run executing right now, or null. The browser
 * route uses it to scope file:// navigation to the page a run is building —
 * the ONLY file:// anything may open through the desktop browser.
 */
export function activeRunDirectory(): string | null {
  return activeRun()?.directory ?? null;
}

/** The id of the run in flight, or null — for evidence that lands server-side. */
export function activeRunId(): string | null {
  return activeRun()?.id ?? null;
}

/**
 * Resolve once the run has finished, or after `timeoutMs`, whichever is first.
 * Lets a status request block instead of polling every few seconds.
 *
 * "Finished" is the settle path's word, not the status field's: the record
 * says `completed` the moment the process is gone, but its work is committed
 * only after that (finishRun), and the waiters are woken once it is. A wait
 * that BEGAN in between — a team's next 60-second slice, for a worker that
 * ended right at the end of the last one — answered at once, and the team
 * merged a branch the commit had not reached yet, then removed the worktree
 * with the files in it (team-v0wcl4mj, t1, 2026-09-26). Such a wait now waits
 * for the wake like any other.
 */
export function waitForRun(id: string, timeoutMs: number): Promise<CodingRun | null> {
  const run = getRun(id);
  if (!run) return Promise.resolve(null);
  if (run.status !== "running" && !store.unannounced.has(id)) return Promise.resolve(run);
  const ms = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
  if (ms === 0) return Promise.resolve(run);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.get(id)?.delete(finish);
      resolve(getRun(id));
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(finish);
  });
}

function wakeWaiters(id: string): void {
  store.unannounced.delete(id);
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of set) fn();
}

// ─── Validation ──────────────────────────────────────────────────────────────

function newRunId(): string {
  // 8 base36 characters: readable, short, and never a 32-hex run the MCP
  // redaction would blank.
  const bytes = randomBytes(6);
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return `run-${n.toString(36).padStart(8, "0").slice(-8)}`;
}

// Owned by the artifacts leaf module (both sides of the runner validate ids);
// re-exported here under the name the routes have always imported.
export const RUN_ID_RE = ARTIFACT_RUN_ID_RE;

/**
 * Did the BOX write this task, rather than a person typing it?
 *
 * True for the follow-ups the runner starts itself — the review pass, a
 * review-loop round. Those fields are internal: no route
 * passes them through from a request body, so a typed task cannot claim this.
 */
function isBoxWrittenTask(input: Pick<StartRunInput, "reviewOf" | "reviewLoopOf">): boolean {
  return typeof input.reviewOf === "string" || typeof input.reviewLoopOf === "string";
}

const BOX_TASK_CLIPPED = "\n…(truncated)";

function normalizeTask(task: unknown, boxWritten = false): string {
  if (typeof task !== "string") throw new CodingAgentError("invalid", "A task is required.");
  const cleaned = task.replace(/\u0000/g, "").trim();
  if (!cleaned) throw new CodingAgentError("invalid", "A task is required.");
  if (boxWritten) {
    return cleaned.length > MAX_BOX_TASK_CHARS
      ? `${cleaned.slice(0, MAX_BOX_TASK_CHARS - BOX_TASK_CLIPPED.length)}${BOX_TASK_CLIPPED}`
      : cleaned;
  }
  if (cleaned.length > MAX_TASK_CHARS) {
    throw new CodingAgentError("invalid", `The task is too long: at most ${MAX_TASK_CHARS} characters.`);
  }
  return cleaned;
}

// Path containment is file-guard's one fence (every run-scoped file check
// uses it); re-exported under the name the browser route has always imported.
export { isInside };

async function realDirectory(abs: string): Promise<string> {
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch {
    throw new CodingAgentError("not_found", "That folder does not exist on this ClawBox.");
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch {
    throw new CodingAgentError("not_found", "That folder does not exist on this ClawBox.");
  }
  if (!stat.isDirectory()) throw new CodingAgentError("invalid", "The working folder must be a directory.");
  return real;
}

/**
 * Where the run works. A project id is the normal case; an explicit folder is
 * accepted under the rules in the header. Returns the real (symlink-resolved)
 * absolute path, which is also what is recorded on the run.
 */
/**
 * The project IDENTITY a secret is scoped by, for a
 * caller that has a `{ projectId | directory }` the way the routes do.
 *
 * a project a run could not reach.
 *
 * Exported rather than re-derived in the routes, because there must be exactly
 * one answer to "which project is this": a route that worked it out its own way
 * would resolve a secret against a scope the store does not know. Goes through
 * `resolveWorkingDirectory` first, so it can never name a project a run could
 * not reach.
 *
 * Null means "not a project" — a folder outside the owner's project folder.
 */
export async function resolveProjectScope(input: { projectId?: string | null; directory?: string | null }): Promise<string | null> {
  const resolved = await resolveWorkingDirectory(input);
  return projectScopeFor({ projectId: resolved.projectId, directory: resolved.directory });
}

export async function resolveWorkingDirectory(input: {
  projectId?: string | null;
  directory?: string | null;
  /**
   * Skip the project-folder rule: the one caller that needs to is
   * setDefaultDirectory, which validates the project folder ITSELF (and a
   * new one is never inside the old). A run never passes this.
   */
  asDefault?: boolean;
}): Promise<{ directory: string; projectId: string | null }> {
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;
  const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;

  // Both roots as normalised absolute paths. Every filesystem call below is
  // made on a path that has been `path.resolve`d and checked to start with
  // one of these — the shape a static analyser recognises as contained — on
  // top of the realpath re-check that catches symlinks.
  const projectsRoot = path.resolve(CONFIG_ROOT, "data", "code-projects");
  const home = path.resolve(homeDir());

  if (projectId) {
    if (!validateProjectId(projectId)) throw new CodingAgentError("invalid", "Invalid project id.");
    const dir = path.resolve(projectPath(projectId));
    if (!dir.startsWith(projectsRoot + path.sep)) throw new CodingAgentError("invalid", "Invalid project id.");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      throw new CodingAgentError("not_found", "There is no code project with that id on this ClawBox.");
    }
    if (!stat.isDirectory()) throw new CodingAgentError("not_found", "There is no code project with that id on this ClawBox.");
    return { directory: await projectFolder(dir, projectsRoot, projectId), projectId };
  }

  if (!directory) {
    // The owner's default, if they set one. Re-validated by falling through
    // into the same checks below — a folder that stopped being allowed since
    // it was set (deleted, moved, replaced by a symlink out of the home) is
    // refused now, not trusted because it passed once.
    const fallback = await getDefaultDirectory();
    if (!fallback) {
      throw new CodingAgentError("invalid", "Give a code project id or a folder to work in.");
    }
    // Every run happens in a folder INSIDE the project folder, never in the
    // project folder itself — a run's folder is a project the owner can find
    // again, and the project folder is the shelf they all sit on.
    throw new CodingAgentError("invalid", `Give a folder inside your project folder (${fallback}) — its name is enough — or a code project id.`);
  }
  if (directory.length > MAX_DIRECTORY_CHARS) {
    throw new CodingAgentError("invalid", "The folder path is too long.");
  }
  if (!path.isAbsolute(directory)) {
    // A bare name means a folder in the owner's default directory. Without
    // this, working on a folder they already have — ~/Projects/my-app —
    // required the assistant to know and type the whole absolute path, and
    // nothing told it the folder existed.
    const base = await getDefaultDirectory();
    if (!base) {
      throw new CodingAgentError("invalid", "The folder must be an absolute path, or a folder name inside your default project folder.");
    }
    if (directory.includes("/") || directory.includes("\\") || directory === "." || directory === "..") {
      throw new CodingAgentError("invalid", "Give a single folder name, or an absolute path.");
    }
    return resolveWorkingDirectory({ directory: path.join(base, directory) });
  }
  const normalized = path.resolve(directory);

  // A code project's folder is always fine, wherever the checkout lives (a
  // dev box keeps it under the working directory, not the home). Spelling it
  // as a path rather than an id still records which project it was.
  if (normalized.startsWith(projectsRoot + path.sep)) {
    const id = path.relative(projectsRoot, normalized).split(path.sep)[0];
    return { directory: await projectFolder(normalized, projectsRoot, id), projectId: validateProjectId(id) ? id : null };
  }

  if (!normalized.startsWith(home + path.sep)) {
    throw new CodingAgentError("invalid", "The working folder must be inside the ClawBox home directory.");
  }
  const real = await realDirectory(normalized);
  const realHome = await fs.promises.realpath(home).catch(() => home);
  // A symlink may lead anywhere; the folder it leads to has to pass the same test.
  if (!isInside(real, realHome)) {
    throw new CodingAgentError("invalid", "The working folder must be inside the ClawBox home directory.");
  }
  // Not the home itself: `acceptEdits` auto-approves every edit UNDER the
  // working folder, and under the home that includes ~/.bashrc and friends.
  if (real === realHome) {
    throw new CodingAgentError("invalid", "Use a folder inside the home directory, not the home directory itself.");
  }
  if (isProtectedFilePath(real)) {
    throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
  }
  for (const sub of DENIED_HOME_SUBTREES) {
    if (isInside(real, path.join(realHome, sub))) {
      throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
    }
  }
  // The owner's rule: every run happens in a folder inside the project
  // folder, so every run's folder is listed under Projects. Only once a
  // project folder is set (a box without one keeps the home rule above), and
  // never for the setting that says where "inside" is (`asDefault`).
  if (!input.asDefault) {
    const base = await getDefaultDirectory();
    if (base) {
      const realBase = await fs.promises.realpath(base).catch(() => path.resolve(base));
      if (real === realBase) {
        throw new CodingAgentError("invalid", `Use a folder inside your project folder (${base}), not the project folder itself.`);
      }
      if (!isInside(real, realBase)) {
        throw new CodingAgentError("invalid", `The working folder must be inside your project folder (${base}), or be a code project.`);
      }
    }
  }
  const checkout = await fs.promises.realpath(CONFIG_ROOT).catch(() => path.resolve(CONFIG_ROOT));
  const realProjects = path.join(checkout, "data", "code-projects");
  if (isInside(real, realProjects) && real !== realProjects) {
    // A symlink into the projects folder: a project after all.
    const id = path.relative(realProjects, real).split(path.sep)[0];
    return { directory: real, projectId: validateProjectId(id) ? id : null };
  }
  if (isInside(real, checkout)) {
    throw new CodingAgentError(
      "invalid",
      "The ClawBox OS checkout itself is off limits. Use a code project or another folder in the home directory.",
    );
  }
  return { directory: real, projectId: null };
}

/** The real path of a folder under the projects root; a symlink that leads out of it is refused. */
async function projectFolder(dir: string, projectsRoot: string, id: string): Promise<string> {
  const real = await realDirectory(dir);
  const realRoot = await fs.promises.realpath(projectsRoot).catch(() => projectsRoot);
  if (!isInside(real, realRoot) || real === realRoot) {
    throw new CodingAgentError("invalid", `The folder of project "${id}" leads outside the projects directory and cannot be used.`);
  }
  return real;
}

// ─── Spawning ────────────────────────────────────────────────────────────────

/**
 * What Claude Code is told on top of its defaults. It is running unattended:
 * nobody can answer a question, and the final message IS the deliverable the
 * assistant relays to the person.
 */
/**
 * The place in the brief where the run is told what to do about review. A
 * run whose changes get a separate review — the owner's automatic review
 * pass, a team's reviewer, or the review pass itself — must not ALSO send
 * the flash reviewer over the same diff: on bench cycle 1 (2026-09-05) that
 * helper cost m-02 45% of its wall time and m-04 a 200-second idle wait,
 * for a diff the pass then reviewed again with Bash in hand. The rest of
 * the delegation sentence stays as it is — see the comment above it.
 */
const REVIEWER_CLAUSE_SLOT = "{{REVIEWER_CLAUSE}}";
const REVIEWER_CLAUSE_HELPER = "before your final report, send the reviewer over your changes (name the files) and fix what it finds.";
const REVIEWER_CLAUSE_SEPARATE = "your changes get a separate, automatic adversarial review on this device — do not send the reviewer helper over your own work; spend that time on the tester.";

/**
 * The place in the brief where the run is told how to use its helpers — the
 * delegation sentence (with its reviewer slot) under the diet's `helpers:
 * "always"`, LEAN_HELPERS_BRIEF under `"lean"`.
 */
const HELPERS_SLOT = "{{HELPERS}}";

// Measured on bench runs run-y3i3y1lk and run-35aq5yh2 (2026-09-03): with
// the softer "when sub-agents are available, use them" the tier model read,
// tested and reviewed everything in its own thread and reported
// subagentsTotal 0 every time — the helpers existed and were never named
// as a step. So the protocol is spelled out as steps, with the reason.
const DELEGATION_SENTENCE =
  "Delegate instead of doing everything in one thread — the sub-agents are how a run stays fast and keeps its own context small: before you edit code that already exists here and you have not read, send the explorer to map it (an empty or freshly scaffolded folder has nothing to map — skip that); after each batch of changes, send the tester to run whatever check exists — the build, the tests, or a script you wrote; and " + REVIEWER_CLAUSE_SLOT + " Do the writing yourself: the explorer, tester and reviewer read, run and review, they never edit.";

/**
 * The diet's `helpers: "lean"` in place of the delegation sentence (TASK-1749).
 * Every helper is a separate context that re-reads what the run already read,
 * so the cheap way to check work is the run's own shell; a helper earns its
 * tokens only on a codebase too large to read, or as one last look at a large
 * change — and never as a second review of a diff a separate pass will read.
 */
export function leanHelpersBrief(reviewedSeparately: boolean): string {
  return [
    "Run the project's tests and builds yourself in your shell — cheaper than a helper.",
    "Use the explorer only for a codebase too large to read directly, handing it the paths and the question.",
    reviewedSeparately
      ? "Do not send the reviewer: a separate review on this device reads your diff."
      // Measured on bench/diet (2026-10-18): with the reviewer kept for
      // "large" changes only, quality fell 0.65 of a point on the judge's
      // ten — id reuse after a delete, a missing viewport tag, a circular
      // import, all what one cheap last look catches. So: once, always.
      : "When the work is done and your own checks pass, send the reviewer exactly once, handing it the changed files, the task's requirements and the edge cases to check instead of letting it re-read the project; fix what it finds, then finish.",
    "Helpers never edit.",
  ].join(" ");
}

/**
 * The helper sentence of a run that has no helpers — a Codex run, which has no
 * sub-agents to send. The same checks, done in its own shell.
 */
export const NO_HELPERS_BRIEF =
  "You have no helper agents: read what you need yourself, run the project's tests and builds in your shell after each batch of changes, and read your own diff once before you finish.";

function helpersSentence(diet: CodingDiet, reviewedSeparately: boolean): string {
  return diet.helpers === "lean"
    ? leanHelpersBrief(reviewedSeparately)
    : DELEGATION_SENTENCE.replace(REVIEWER_CLAUSE_SLOT, reviewedSeparately ? REVIEWER_CLAUSE_SEPARATE : REVIEWER_CLAUSE_HELPER);
}

/**
 * The brief for a run whose changes are (or are not) reviewed separately.
 *
 * `diet` (src/lib/coding-diet.ts) picks the full brief or the lean one and the
 * helper sentence; `visual` and `pullRequest` matter to the LEAN brief only:
 * its browser block is there only for a visual run, and its auto-merge
 * sentence only for a run that can open a pull request or was asked about
 * one. Omitted, `diet` is LEGACY_DIET: the pre-diet brief byte for byte.
 */
export function headlessBrief(opts: { reviewedSeparately: boolean; team?: boolean; diet?: CodingDiet; visual?: boolean; pullRequest?: boolean; noHelpers?: boolean }): string {
  const diet = opts.diet ?? LEGACY_DIET;
  const helpers = opts.noHelpers ? NO_HELPERS_BRIEF : helpersSentence(diet, opts.reviewedSeparately);
  // A team's run is told the opposite of PR_AUTO_MERGE_BRIEF, in its place: a
  // team goal that asks for a merge is the ORCHESTRATOR's to carry out, once,
  // at the end — never a worker's, whatever its task text quotes of the goal.
  if (diet.brief === "lean") {
    const merge = opts.team ? TEAM_NO_MERGE_BRIEF : opts.pullRequest ? PR_AUTO_MERGE_BRIEF : null;
    return [
      ...LEAN_BRIEF_HEAD,
      helpers,
      ...LEAN_BRIEF_MIDDLE,
      ...(opts.visual !== false ? [LEAN_VISUAL_BRIEF] : []),
      ...LEAN_BRIEF_TAIL,
      ...(merge ? [merge] : []),
      LEAN_FINAL_MESSAGE,
    ].join(" ");
  }
  const brief = HEADLESS_BRIEF_TEMPLATE.replace(HELPERS_SLOT, helpers);
  return opts.team ? brief.replace(PR_AUTO_MERGE_BRIEF, TEAM_NO_MERGE_BRIEF) : brief;
}

/**
 * What a coding team's run is told about pull requests, instead of
 * PR_AUTO_MERGE_BRIEF. Seen live: a worker whose task text quoted a goal
 * ending "…and merge the PR" merged it itself, mid-team, before the other
 * tasks were in. `TEAM_MERGE_DENYLIST` and the hook's merge guard refuse the
 * commands; this says why, so the run does not spend its turns on them.
 */
export const TEAM_NO_MERGE_BRIEF =
  "You are one run of a coding team. Never merge a pull request, never push, and never turn on auto-merge — whatever your task or the team's goal says. The team's orchestrator opens and merges the pull request itself, once every task is accepted, the project's tests pass, the final review passed and every check is green; `gh pr merge`, `gh api` and `git push` are refused to you. Commit your work in your own folder and say in your final message what is ready.";

/**
 * The commands a coding team's run is refused outright (`--disallowedTools`):
 * merging a pull request, and the roads around it — the API (`gh api`, the
 * REST merge endpoint and the GraphQL mutation alike) and a push, which is a
 * merge by other means. A worker's branch reaches the team's branch through the
 * orchestrator's local merge, so a team run has no use for any of them. The
 * prefix rules are the first fence; the hook's PreToolUse merge guard
 * (scripts/coding-run-hook.mjs) reads the whole command line for the same
 * shapes inside `bash -c`, after `&&` or behind `env`.
 */
export const TEAM_MERGE_DENYLIST: readonly string[] = [
  "Bash(gh pr merge:*)",
  "Bash(gh api:*)",
  "Bash(git push:*)",
  "Bash(hub merge:*)",
];

/**
 * What every run that can write is told about a pull request its task wants
 * merged — one sentence of the headless brief, exported for its test.
 *
 * Measured on ClawBox's own repository (2026-09-22): eight pull requests went
 * green in the afternoon and evening and were merged together at 05:18 the
 * next morning, ten to sixteen hours later. A run that waits on CI to merge
 * spends its turns polling and ends before a slow install check does, and a
 * watcher that merges gives up at its ceiling. Handing the merge to GitHub the
 * moment the pull request is open is what closes that gap, with the required
 * checks still the gate. Conditional on the TASK asking for the merge, because
 * the task is the consent: a run told only to open a pull request is not told
 * to merge it. The device's own watchers do the same for the pull requests
 * they watch (reconcileAutoMerge), under the owner's merge switch.
 */
export const PR_AUTO_MERGE_BRIEF =
  "If your task has you open a pull request and wants it merged, hand the merge to GitHub as soon as it is open instead of waiting on CI yourself: `gh pr merge <number> --auto --merge` merges it the moment its required checks pass, and the repository's own setting deletes the branch. Never do that for a pull request into main or one labelled hold or do-not-merge, and not on a draft (turn it on after `gh pr ready`). If a review leaves findings you are going to fix, turn it off first (`gh pr merge <number> --disable-auto`) and on again once the fix is pushed. If GitHub refuses it (auto-merge off for that repository, or nothing required on the branch), merge the way your task says.";

const HEADLESS_BRIEF_TEMPLATE = [
  "You are running unattended on a ClawBox — a small Linux device on someone's desk — inside the folder you were started in, on behalf of the device's assistant.",
  "Nobody can answer questions, so make sensible assumptions and keep going. Stay inside this folder; do not install system packages or change device settings.",
  // Learned from bench run run-g6vwqr9y (2026-08-27): the run's Edit on a
  // path outside its folder was denied, so it made the same change with
  // `sed -i` through Bash and reported success. A denial the tools enforce
  // must not be a puzzle Bash solves.
  "A denied file action is a DECISION by this device, not a flaky prompt: if Read, Write or Edit is refused for a path, do not touch that path by any other route — no sed, tee, redirection or scripts through Bash. Do the parts of the task that stay inside this folder, and report plainly which part was refused and why you left it undone.",
  // The same s-02 run decided its in-folder edit at +13 s, then spent the
  // rest of its time on the doubtful step and timed out with nothing on disk.
  "Do the parts you are sure of and that are inside this folder FIRST — make those edits before you investigate anything doubtful, so a run stopped part-way has still delivered them. If the task names a file outside this folder, try that step once with Edit or Write — never through Bash — so the device's refusal is on the record, then carry on.",
  "The task text may carry copy-paste artifacts. If a detail is plainly garbled — a nonsense number, a broken word — ship the sensible correction and note it in your final report; do not reproduce an obvious error verbatim.",
  "Verify efficiently: use browser_fill to set a form field by selector and browser_click on controls; never navigate a page one Tab or arrow key at a time — a whole step budget was once spent that way.",
  "The ClawBox checkout (/home/clawbox/clawbox), its data/ folder, your own run record and any session files are not yours to inspect: reads there are refused, and every attempt costs a step. The one exception is your own evidence folder (CLAWBOX_RUN_ARTIFACTS_DIR), which lives under data/ and is yours to read and write. Work inside your project folder and your evidence folder only.",
  // The failure this answers: the assistant generated four pictures for the
  // task into its own media folder — inside the credential store every run is
  // denied — and the run, refused by both Read and `cp`, drew them again. The
  // box now copies what it was handed into CLAWBOX_RUN_INPUTS_DIR, so the run
  // needs to know where that is and, just as much, that hunting for the
  // original is a refusal it cannot argue with.
  "Files you were GIVEN for this task — pictures, recordings, documents — are in the folder named by CLAWBOX_RUN_INPUTS_DIR, and you may read anything under it (its `shared` folder included). Copy what you need into your own folder from there. The assistant's own media folder is NOT readable by a run and never will be: if something you were promised is missing from your inputs folder, say so in your report rather than looking for it elsewhere.",
  // Bench task s-02 (2026-09-05): the run listed two sibling projects and
  // walked their .git internals looking for a file the task had misplaced.
  "The folders beside yours under the project root are the owner's other projects: never list, search or read them.",
  // The old sentence here said one command per call and that chaining was
  // refused — true under the retired allow-list, false since runs got
  // `Bash(*)` (see buildRunArgs), and every bench run of cycle 1 (2026-09-05)
  // split its commands anyway. The one command rule that IS enforced is the
  // kill-by-name list (BASH_KILL_DENYLIST).
  "You may chain commands with && or ;, pipe, redirect, use a heredoc and start a server in the background inside one Bash call — keep each call to one purpose. End anything you started by its PID: pkill, killall and fuser are refused.",
  // The delegation sentence (DELEGATION_SENTENCE), or the diet's lean one.
  HELPERS_SLOT,
  // The -p mechanics, measured on this box (2026-09-03): a helper is launched
  // in the background, the model's turn ends, and the CLI restarts the same
  // session with each result. Left unsaid, the model spent its steps asking
  // itself how to wait.
  "Sub-agents and workflows run in the background: launch independent ones together and keep working while they run; when nothing is left but waiting, end your turn with one line saying what is still out — you are restarted with each result as it arrives. Never poll for them, and never read their transcripts or session files.",
  "Verify your work where you can (run the build or the tests you have).",
  "For live web verification, start your app as a background child in this working folder and use browser_open on http://127.0.0.1:PORT (an unprivileged port). Only a listener owned by this run is allowed; other local services stay blocked. `node \"$CLAWBOX_PREVIEW\" --ttl 900` does this for you when the project has no server of its own — it builds, serves the folder on an ephemeral loopback port and prints PREVIEW_PID and PREVIEW_URL. Verify the real API-backed UI, not a static shim. Stop test servers when finished; Team workers have their remaining process group cleaned up automatically.",
  "The clawbox browser tools drive this device's own Chromium. You cannot see images — browser_view_local, browser_open and browser_screenshot save a screenshot into the run's evidence folder and answer with a written description of it; the interaction tools (click, type, keypress, scroll) answer briefly without one. When you build something with a visible result, open its live app with browser_open, or use browser_view_local for a standalone HTML file and read the description of what actually renders before you report done.",
  "Verify deliberately, not exhaustively: take a described screenshot at each state that matters and move on — never one per keystroke, and never watch a timer or animation run its course when a short interval proves the logic. A handful of screenshots is a verified app; fifty is a stalled one.",
  "You have a limited number of steps and every tool call spends one. Driving a page key by key through the browser is the fastest way to run out mid-task (measured: one run spent 103 steps on single keypresses and was cut off) — prove logic with a small script run by node instead, and spend the browser on ONE visual pass of the states that matter.",
  // Bench run run-droy3ws4 (2026-09-03) COPIED its checker into the evidence
  // folder and left the original in the project: the grep patterns inside it
  // ("TODO", "lorem ipsum") and the synopses it checked for then counted as
  // the project's own, and a 96-point site scored 54.
  "The folder named in CLAWBOX_RUN_ARTIFACTS_DIR is this run's evidence folder, shown to the owner with the run's details. Screenshots land there automatically; save test output there too, and MOVE any verification script you wrote there (mv, never a copy): a checker left behind in the project folder ships as part of the project.",
  "A short task is not a small task: deliver the complete, polished result the task implies — real styling, sensible edge handling, a finished feel — never a minimal stub.",
  // Bench run run-nmtf8v2o (2026-09-05): an eight-file site was written and
  // working inside six minutes, then fourteen more went on a screenshot of
  // every page and a review workflow over work already verified, and the
  // run was cut off before its report — the work was there, the account of
  // it never came, and two points went with it. One pass of verification is
  // the finish line, not the start of another.
  "Finish decisively: once the work is done and ONE verification pass — the tests you have, one visual pass of the states that matter, one review — has passed, write your report and stop. Do not review verified work a second time, re-screenshot pages already described, or start a workflow whose only job is to look again: a run that runs out of time before its report loses the report, and the report is what the owner reads.",
  // The same run added a hero picture and left a checker script beside an
  // "exactly these files" brief, and lost three points to files nobody asked
  // for; s-02's run (2026-09-05) spent five minutes searching the disk for a
  // file that was not where the task said it would be.
  "Deliver what the task names and nothing beside it: when it lists the files to produce, produce exactly those — no extra assets, pictures, notes or scripts, however nice; anything you make only to check your work goes to the evidence folder. When a file or folder the task relies on is not where the task says, look once where it points, then treat that step as undoable and report it — never search the disk for it.",
  PR_AUTO_MERGE_BRIEF,
  "Your final message is delivered to the person who delegated the task. State what you changed (file names), how they can check it, anything you could not finish, and every assumption you made where the task left a choice open — name the convention or default you picked and why.",
].join(" ");

/**
 * The diet's LEAN brief (TASK-1749, src/lib/coding-diet.ts): every rule of
 * HEADLESS_BRIEF that prevents a real failure, said in as few words as
 * possible and without the anecdotes — the comments on HEADLESS_BRIEF_TEMPLATE
 * keep the reasons. Assembled by `headlessBrief`: the head, the helper
 * sentence, the middle, the browser block for a visual run only, the tail, the
 * merge sentence where it applies, and the final-message rule.
 */
const LEAN_BRIEF_HEAD = [
  "You run unattended on a ClawBox, a small Linux device, in the folder you were started in, for the device's assistant.",
  "Nobody can answer questions: make sensible assumptions and keep going. Stay in this folder; install no system packages, change no device settings.",
  "A refused Read, Write or Edit is a decision: never reach that path another way (no sed, tee, redirection or scripts through Bash) — report it undone.",
  "Make the in-folder edits you are sure of FIRST. A step on a file outside this folder: try it once with Edit or Write, never Bash, then carry on.",
  "The ClawBox checkout (/home/clawbox/clawbox), its data/ folder, your run record and session files are off limits, except your evidence folder ($CLAWBOX_RUN_ARTIFACTS_DIR). Folders beside yours are the owner's other projects: never list, search or read them.",
  "Files you were given are in $CLAWBOX_RUN_INPUTS_DIR; if one is missing, say so rather than look elsewhere.",
  "Bash may chain, pipe and background; end what you started by PID (pkill, killall and fuser are refused).",
  // Every turn re-sends everything already in the context, so what enters it
  // is paid for again on each later turn (bench/diet tabulate-refactor: a
  // 2,700-line module read whole kept the context at ~150k for 40+ turns).
  "Keep your context small — everything in it is re-sent every turn: Grep before you Read, read a large file in ranges (offset/limit) rather than whole, never re-read a file you already have, and keep command output short (quiet flags, `| tail -n 40` on long test or build output).",
];

const LEAN_BRIEF_MIDDLE = [
  "Helpers run in the background: when only waiting is left, end your turn with one line on what is out — you are restarted with each result. Never poll them or read their transcripts.",
];

/** The lean brief's browser and visual-verification block — a visual run's only. */
export const LEAN_VISUAL_BRIEF = [
  "To check a web app, start it as a background child in this folder and browser_open http://127.0.0.1:PORT (an unprivileged port; only your own listener is reachable) — or run `node \"$CLAWBOX_PREVIEW\" --ttl 900`, which builds, serves and prints PREVIEW_PID and PREVIEW_URL. Verify the real API-backed UI, not a static shim; stop test servers when done.",
  "You cannot see images: browser_view_local (a standalone HTML file), browser_open and browser_screenshot save a screenshot to the evidence folder and answer with its description — read it before you report done.",
  "Set fields with browser_fill and use browser_click; never drive a page key by key — prove logic with a small node script, and spend the browser on ONE pass, one screenshot per state that matters.",
].join(" ");

const LEAN_BRIEF_TAIL = [
  "Save test output to the evidence folder and MOVE (mv, never copy) any checker script you wrote there.",
  "Deliver complete, polished work: exactly the files the task names, nothing beside them. If a file the task relies on is not where it says, look once, then report that step undone — never search the disk.",
  "Finish decisively: once ONE verification pass (the build or tests you have) passes, report and stop.",
];

const LEAN_FINAL_MESSAGE =
  "Your final message goes to the person who delegated: what you changed (file names), how to check it, what is unfinished, and every assumption you made where the task left a choice open, and why.";

/** The brief of a run with no separate review — the reviewer helper is its review. */
export const HEADLESS_BRIEF = headlessBrief({ reviewedSeparately: false });

/**
 * The lean brief of an ordinary run that is not visual and has no pull
 * request in sight, with the original ("always") helper sentence — the counterpart of
 * HEADLESS_BRIEF, exported for its size test.
 */
export const LEAN_HEADLESS_BRIEF = headlessBrief({ reviewedSeparately: false, diet: { ...LEGACY_DIET, brief: "lean" }, visual: false, pullRequest: false });

/**
 * Added for a run whose branch the box will open a pull request from (the
 * auto-PR switch was on when it started). A run whose task says to open its
 * own runs `gh pr create`, and the settle adopts that pull request and
 * watches it (maybeOpenPullRequest). It has to be a draft for the same reason
 * the box's own are: CodeRabbit reviews a pull request once, when it becomes
 * ready, and the watcher readies it only after the checks pass. Left out for
 * every other run, because a draft that nothing watches is never readied.
 *
 * It comes AFTER the headless brief's PR_AUTO_MERGE_BRIEF and overrides it by
 * name: this run's pull request is the device's to arm (reconcileAutoMerge),
 * after CodeRabbit's one review has been read, never the run's at open time.
 */
export const PR_DRAFT_BRIEF =
  "If your task asks you to open a pull request, open it as a draft (`gh pr create --draft`; without --draft only when GitHub refuses drafts in that repository): this device watches it, marks it ready for review once its checks pass, which is when CodeRabbit gives its one review, and merges it or hands it back as the owner's settings say. Do not mark it ready, ask for a review or merge it yourself — and do not turn on its auto-merge either: the device does that once nothing on it is outstanding.";

/**
 * Added to the brief under ultracode only: what the Workflow tool is for on
 * this box. The CLI's own reminder says "use it on every substantive task;
 * token cost is not a constraint", and the inline reference it ships offers
 * writer fan-outs, worktree isolation and scriptPath re-runs — each of which
 * is wrong here: a run is single-writer by design (the record's changed
 * files and the review pass that hangs off them come from the main loop's
 * own edits; a workflow agent's writes would reach the commit — it stages
 * the whole folder — and nothing else), the
 * folder is not a git repository of its own, the session files are denied
 * paths where every Read costs a step, and the owner's ceilings do apply. So
 * this says what a workflow IS for on this box — many read-only helpers in
 * one step — and names the three traps by name.
 */
/**
 * The brief for a run that may only READ — a team's planner. The headless
 * brief describes Bash, the browser tools, the evidence folder and the
 * workflow fan-out, none of which such a run has; a model told about them
 * spends its steps on calls that are refused.
 */
export const READ_ONLY_BRIEF = [
  "You are running unattended on a ClawBox — a small Linux device on someone's desk — inside the folder you were started in, on behalf of the device's assistant.",
  "Nobody can answer questions, so make sensible assumptions and keep going. This is a READ-ONLY session: you have Read, Grep and Glob and the read-only helper agents, no shell, no browser and no way to write — do not try to edit, create or run anything; your ANSWER is your final message.",
  "Delegate reading to the explorer helper when a question spans many files, and keep your own context small. You have a limited number of steps and every tool call spends one.",
  "The task text may carry copy-paste artifacts; read past them. Your final message is delivered to the party that started you and is read by a program as well as a person: answer in exactly the form the task asks for, with nothing before or after it.",
].join(" ");

export const ULTRACODE_BRIEF = [
  "Ultracode is on and the Workflow tool is approved for this run: it is the one-step way to run many READ-ONLY helpers at once — map many files, verify many pages, review many changes — with agent(), parallel() and pipeline().",
  "Every agent() must pass agentType \"explorer\", \"tester\" or \"reviewer\" (never general-purpose, never a workflow inside a workflow, never isolation: \"worktree\" — this folder is not a git repository of its own), and the writing stays with you: shared code first, then the parts, then a workflow to check them all.",
  "The owner's step and token ceilings apply to this run and every token a workflow's agents spend is billed to it, whatever the reminder says about cost — size a workflow to the task: a task of one to three files needs no workflow at all (the explorer, tester and reviewer helpers are enough), a larger one at most ONE, launched when there are many things to check at once, never to review work you have already verified.",
  "A script's meta must be a plain object literal. If a workflow fails or returns nothing useful, send a narrower script inline — never scriptPath or resumeFromRunId, and never Read the script file, transcript or journal its result names: that folder is closed to you and each attempt costs a step.",
  // Every ultracode run of bench cycle 1 (2026-09-05) re-argued the CLI's
  // "use it on every substantive task" reminder against the brief, and m-04
  // wrote a 90-line script to run two helpers.
  "Decide the shape once and do not re-argue whether the ultracode reminder applies: a folder you have already read in full needs no explorer and no workflow, and a change of a few files that the project's own tests prove is finished once those tests pass. For one or two helpers call the Agent tool directly (several Agent calls in one message run together); a Workflow is for a fan-out of many, never for a folder of two files.",
].join(" ");

/**
 * Added to the brief only for a run whose owner left the picture switch on.
 *
 * Three things have to be said, and each of them was learned somewhere else in
 * this file: what the tool actually costs (the ClawBox AI allowance is
 * per-UTC-day and 1/day on the free plan — see clawai-images.ts), that a
 * refusal naming the allowance is an answer and not a flake (a small model
 * retries a 429 forever otherwise), and that the project's own icon is drawn
 * for it — a run that drew its own would spend two pictures on one file and
 * then lose the race with `wx`.
 *
 * The last sentence forbids the substitute a capable model reaches for when it
 * cannot draw: rendering an SVG or a PIL canvas to PNG and calling it art. That
 * is not what the owner asked for and it looks like it.
 */
export const MEDIA_BRIEF_IMAGES = [
  "generate_image draws a real picture with this box's ClawBox AI plan and writes a PNG into your working folder — hero art, sprites, backgrounds, textures, a logo.",
  "Spend it on the handful of pictures that carry the project, never one per element: each costs the owner's daily allowance, and a refusal that names the allowance or the credential means carry on without pictures rather than retry.",
  "Do not fake one with an SVG-to-PNG script or a Python imaging library, and do not draw the project's own icon: this box draws favicon.png, favicon.ico and the desktop icon for you shortly after the run starts. Before you finish, check with Glob that favicon.png is there and link <link rel=\"icon\" href=\"favicon.png\"> from every page only then — when the allowance was spent or the drawing failed, the files never arrive, and a link to a file that is not there is a broken link in every page you ship.",
].join(" ");

/**
 * The audio half. Its costs are not the pictures' costs, so it says its own:
 * synthesis is ONE box-wide slot shared with the chat's spoken replies
 * (withSpeechQueue in voice-speak.ts), and Kokoro refuses outright when the
 * board is short of memory — which a run's own node build makes likely, and
 * which is a fact about the box rather than about the sentence.
 */
export const MEDIA_BRIEF_AUDIO = [
  "generate_audio speaks text in this box's own voice and writes a WAV into your working folder — narration, a greeting, a spoken cue.",
  "Keep the clips short and few: the box has one voice and the chat shares it, so \"busy\" or a memory refusal means try once more later and then carry on without sound.",
].join(" ");

/**
 * Every tool a deny rule has to name to shut a path — which is every FILE tool
 * a run is actually given (`CLAUDE_TOOLS`), not just the three that open a file
 * by name.
 *
 * A permission rule in Claude Code is PER TOOL: `Read(//x/**)` says nothing
 * about `Grep`. With only Read/Edit/Write here, a run could `Grep` the contents
 * of `data/config.json` or `Glob` the credential stores it may not `Read` — the
 * protected-path floor held for three of the six doors and stood open at the
 * others. `NotebookEdit` is the one that could WRITE through the gap.
 *
 * Kept in step with `CLAUDE_TOOLS` by `file-tools-cover-every-file-tool` in the
 * unit suite: a tool added there and not here reopens exactly this hole.
 */
const FILE_TOOLS = ["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"] as const;
/** Always denied under data/, whether or not they exist yet. */
// email-outcomes.json sits beside email-pending.json for the same reason: it
// names who the owner mailed and what about. A run has no business reading
// either, and a file that only exists once mail has been approved is exactly
// the kind that gets added to the store and forgotten here.
//
// email-approval-prompts.json joined them for a weaker reason and is kept for
// it: it holds no message text and only the HASH of the code the owner types
// (email-approval-prompts.ts), so reading it yields nothing usable — but it is
// the approval machinery's own record, it sits in the same directory as the two
// above, and a run that has no business in either has none in it.
//
// coding-agent-streams/ is the runs' own stream logs (STREAM_DIR). Listed for
// exactly the reason this list exists: the directory is created by the FIRST
// spawn, after that spawn's rules have already been computed from what was on
// disk, so discovery alone would leave it open for one run — every other run's
// log is deleted at its settle, but a team's three workers are live together.
// It is also where a run's MCP config FILE waits (writeRunMcpConfig) when its
// project opted into a harness server: that file holds the server's env and
// headers, and is denied to every run — its own included — by this one name.
//
// secrets.json is the newest and the plainest of them: the owner's own
// credentials, encrypted with a key derived from `.session-secret` — which is
// already on this list, and the two are worth nothing apart. A run is HANDED
// the secrets the owner ticked for it, as environment variables; reading the
// file would hand it the ones they did not, including another project's.
//
// coding-agent-history/ and coding-agent-archive/ are every OTHER run's records,
// inputs and transcripts (src/lib/coding-run-history.ts). Named rather than
// discovered for the stream logs' reason: the first run to leave the live list
// creates them, possibly while another run is already working.
//
// secrets-audit.log is the secret store's trail (src/lib/secrets-audit.ts):
// names, scopes and run ids, never a value — but which projects hold which keys
// and which runs were handed them is the owner's to read, not a run's. Named
// for the same reason: the first copy, tick or injection creates it.
const DATA_SECRET_FILES = ["config.json", "kv.json", ".mcp-token", ".session-secret", "email-pending.json", "email-outcomes.json", "email-approval-prompts.json", "coding-agent-runs.json", "coding-agent-streams", "coding-agent-history", "coding-agent-archive", SECRETS_FILE_NAME, SECRETS_AUDIT_FILE_NAME];

/**
 * Entries of the harness's state directories (`HARNESS_STATE_SUBTREES`) that
 * are denied by NAME, even when a project subtree beside them has been
 * unlocked and even when they do not exist yet: the OAuth credential, the
 * settings, the shell and session history, the daemon's own files.
 *
 * Listed rather than discovered, for the same belt-and-braces reason
 * `DATA_SECRET_FILES` is: `denyEntries` denies every entry it can READ, so the
 * list is what covers a store the harness has not written yet — on a fresh box
 * most of these do not exist, and they must be shut the moment they appear.
 *
 * `backups`, `file-history` and `plans` earn their place for a second reason:
 * they hold the CONTENT of files from every folder the harness has ever
 * touched, so leaving one open would undo the containment the project split is
 * for — a rule naming one project would read every other project's source.
 */
const HARNESS_STATE_SECRETS = [
  // Credentials, settings and history.
  ".credentials.json", ".claude.json", "settings.json", "settings.local.json",
  "history.jsonl", "sessions", "session-env", "shell-snapshots", "todos",
  // Cross-project file content — see above.
  "backups", "file-history", "plans", "cache", "paste-cache",
  // The daemon's own state, the IDE bridge, and everything installed into the
  // harness rather than written by a run.
  "daemon", "daemon.log", "daemon.status.json", "daemon.lock",
  "ide", "plugins", "skills", "statsig", "telemetry", "debug", "downloads",
  "jobs", "tasks", "stats-cache.json",
];

/**
 * Claude Code's Read/Edit/Write rules for the paths a run must not open.
 * `//` = absolute path in that rule syntax (a single leading slash would mean
 * "relative to the project root").
 *
 * Neither the checkout nor its data/ is denied wholesale: a deny rule
 * outranks `acceptEdits`, and the run's own working folder is usually
 * data/code-projects/<id>, inside both. Instead every entry of each is denied
 * individually — data/ except its public subtrees (the same containment rule
 * file-guard applies to the ClawBox file tools), and the checkout except
 * data/ itself, whose entries the first pass already covered. Without the
 * second pass the brief's promise that the checkout is off limits held for
 * nothing but data/ and .env: src/, mcp/ and scripts/ were open to Read.
 *
 * THE ONE EXCEPTION, AND WHAT IT COSTS. A deny rule outranks an allow rule in
 * Claude Code, so while `~/.claude-ds/**` is denied wholesale no owner rule can
 * reach the harness's own per-project notes — the refusal this feature exists to
 * answer. Given an owner rule that names one such project folder
 * (`unlockedSoftPaths`), the broad tree deny is replaced by TWO passes of
 * entry-by-entry denials: everything in `~/.claude-ds` except `projects`, and
 * everything in `~/.claude-ds/projects` except the one project the rule named.
 * The OAuth token, the settings and every OTHER project stay denied; exactly one
 * folder opens. `HARNESS_STATE_SECRETS` is listed even when absent, the same
 * belt-and-braces `DATA_SECRET_FILES` gets, so a store that has not been written
 * yet is still denied. `allowRules` must already be validated — `buildRunArgs`
 * is the only caller that passes any, and it normalises first.
 *
 * @param allowRules the owner's rules for THIS run, already validated; none
 *                   means the wholesale denials every other caller gets
 */
export function fileDenyRules(allowRules: readonly string[] = []): string[] {
  const home = homeDir();
  const rules: string[] = [];
  const denyTree = (root: string) => {
    for (const tool of FILE_TOOLS) rules.push(`${tool}(/${root}/**)`);
  };
  const denyFile = (file: string) => {
    for (const tool of FILE_TOOLS) rules.push(`${tool}(/${file})`);
  };
  /** Every entry of `dir` except those `keep` names, each by what it is now. */
  const denyEntries = (dir: string, fixed: readonly string[], keep: (entry: string) => boolean) => {
    const entries = new Set<string>(fixed);
    try {
      for (const entry of fs.readdirSync(dir)) entries.add(entry);
    } catch {
      // no such folder yet — the fixed list still applies
    }
    for (const entry of [...entries].sort()) {
      if (keep(entry)) continue;
      const abs = path.join(dir, entry);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        // Listed but absent — which is the whole reason the fixed lists exist.
      }
      if (stat === null) {
        // It could appear as EITHER, and these rules are computed once at
        // spawn: a run that creates `file-history/` after that would otherwise
        // face a rule naming the path exactly and nothing covering what is
        // inside it. Both forms cost two argv entries and shut both outcomes.
        denyFile(abs);
        denyTree(abs);
      } else if (stat.isDirectory()) {
        denyTree(abs);
      } else {
        denyFile(abs);
      }
    }
  };
  const unlocked = [...new Set(unlockedSoftPaths(allowRules, home))];
  for (const sub of DENIED_HOME_SUBTREES) {
    const root = path.join(home, sub);
    // The soft child of THIS subtree that holds an unlocked project, as its own
    // last segment ("projects"), and the folders inside it that are open.
    // SOFT_HOME_SUBTREES is one segment deep inside its parent by construction,
    // which is what makes that slice sound.
    //
    // Only the HARNESS state directories are consulted at all. Every soft
    // subtree that exists today is a child of one of them, and pinning it here
    // is what makes that a GUARANTEE rather than a coincidence: a future
    // `SOFT_HOME_SUBTREES` entry naming a child of `.ssh` or `.openclaw` opens
    // nothing, because a hard subtree never reaches this branch.
    const open = (HARNESS_STATE_SUBTREES.includes(sub) ? SOFT_HOME_SUBTREES : [])
      .filter((soft) => soft.startsWith(`${sub}/`))
      .map((soft) => ({ entry: soft.slice(sub.length + 1), dir: path.join(home, soft) }))
      .filter(({ dir }) => unlocked.some((p) => p.startsWith(`${dir}${path.sep}`)));
    if (open.length === 0) {
      denyTree(root);
      continue;
    }
    // Pass one: the harness's own state beside `projects` stays shut.
    denyEntries(root, HARNESS_STATE_SECRETS, (entry) => open.some((o) => o.entry === entry));
    // Pass two: every project EXCEPT the ones the owner named. A project that
    // does not exist on disk yet gets no rule either way — there is nothing to
    // deny, and the allow rule is what would open it once it appears.
    for (const { dir } of open) denyEntries(dir, [], (entry) => unlocked.includes(path.join(dir, entry)));
  }
  denyEntries(DATA_DIR, DATA_SECRET_FILES, (entry) => DATA_DIR_PUBLIC_SUBTREES.has(entry));
  denyEntries(CONFIG_ROOT, [".env"], (entry) => path.join(CONFIG_ROOT, entry) === DATA_DIR);
  return rules;
}

/** True when a Read/Edit/Write deny rule would cover `directory` — the check the contract test runs. */
export function denyRulesCover(rules: readonly string[], directory: string): boolean {
  return rules.some((rule) => {
    const m = /^(?:Read|Edit|Write)\(\/(.+?)(\/\*\*)?\)$/.exec(rule);
    if (!m) return false;
    const root = m[1];
    return m[2] ? isInside(directory, root) : directory === root;
  });
}

/**
 * The browser family a run may call through the clawbox MCP server — and the
 * ONLY MCP tools a run may call: --strict-mcp-config keeps other servers out,
 * the browser profile keeps the rest of the clawbox tool set unregistered,
 * and this allow-list is what approves the calls in headless mode.
 * Exported for the contract test.
 */
export const MCP_BROWSER_TOOLS = [
  "mcp__clawbox__browser_view_local",
  "mcp__clawbox__browser_open",
  "mcp__clawbox__browser_navigate",
  "mcp__clawbox__browser_screenshot",
  "mcp__clawbox__browser_close",
  "mcp__clawbox__browser_click",
  "mcp__clawbox__browser_type",
  "mcp__clawbox__browser_fill",
  "mcp__clawbox__browser_keypress",
  "mcp__clawbox__browser_scroll",
  // Not a browser tool, but registered in the same run profile: the written
  // description of a local image file, for models that cannot see pixels.
  "mcp__clawbox__describe_image",
] as const;

/**
 * The two media tools, by the switch that offers each.
 *
 * Kept apart from MCP_BROWSER_TOOLS rather than folded into it because they
 * are CONDITIONAL: a run whose owner switched pictures off is never told the
 * tool exists, which is the difference between a capability and a refusal the
 * model will spend steps arguing with.
 */
export const MCP_MEDIA_TOOLS: Record<keyof RunMedia, string> = {
  images: "mcp__clawbox__generate_image",
  audio: "mcp__clawbox__generate_audio",
};

/**
 * The one tool a run of a coding TEAM gets beside the rest: `team_message`
 * (coding-team-messages.ts) — a bounded, logged note to a sibling run, to the
 * team's lead, or to the box's main agent. Allowed for EVERY team run, the
 * read-only planner and reviewer included: it writes nothing in the project,
 * and "the file the task names does not exist" is exactly what a planner
 * should be able to say. The run's own MCP server registers it only when the
 * environment below names the team, so no other run is ever offered it.
 */
export const MCP_TEAM_TOOL = "mcp__clawbox__team_message";

/**
 * "ClawBox read-only tools", approved by name for a run whose project ticked
 * them (src/lib/project-mcp-servers.ts) — the same readOnly set the run's
 * server registers under the `run-read` profile (src/lib/clawbox-run-read-tools.ts).
 * Never a whole-server `mcp__clawbox`: a write tool the profile ever let
 * through would still wait for an approval nobody is there to give.
 */
export const MCP_READ_ONLY_TOOLS: readonly string[] = CLAWBOX_READ_ONLY_TOOLS.map((tool) => `mcp__clawbox__${tool}`);

/** Every MCP tool this run may call: the browser family, plus what it may draw and say. */
export function runMcpTools(media: RunMedia | undefined): string[] {
  const tools: string[] = [...MCP_BROWSER_TOOLS];
  if (media?.images) tools.push(MCP_MEDIA_TOOLS.images);
  if (media?.audio) tools.push(MCP_MEDIA_TOOLS.audio);
  return tools;
}

/**
 * The media the run's own MCP server registers, as its environment names it.
 *
 * A comma-separated list rather than two booleans so a run with neither gets
 * NO variable at all, which is what the server reads as "register nothing".
 * It carries no secret — see buildRunMcpConfig.
 */
export function runMediaEnv(media: RunMedia | undefined): string {
  return [media?.images ? "images" : null, media?.audio ? "audio" : null].filter(Boolean).join(",");
}

/**
 * The MCP config a run gets: the clawbox server in its browser-only profile.
 * No token in here — argv is world-readable in /proc, so the server reads
 * data/.mcp-token itself through its normal file fallback. Exported for the
 * contract test.
 */
export function buildRunMcpConfig(run: { id: string; directory: string; media?: RunMedia; team?: RunTeam | null }, opts: { visual?: boolean } = {}): string {
  return JSON.stringify({ mcpServers: { clawbox: runClawboxServer(run, { visual: opts.visual !== false, readOnlyTools: false }) } });
}

/**
 * The MCP config FILE of a run whose project opted into more
 * (writeRunMcpConfig): the run's own clawbox server — in the `run-read`
 * profile when the read-only tools were ticked, and only when it has anything
 * to register — beside the harness servers exactly as the plan carries them.
 * Exported for the contract test.
 */
export function buildRunMcpFileConfig(run: { id: string; directory: string; media?: RunMedia; team?: RunTeam | null }, plan: Pick<RunMcpPlan, "servers" | "readOnlyTools">, opts: { visual: boolean }): string {
  const clawbox = opts.visual || run.team || plan.readOnlyTools
    ? { clawbox: runClawboxServer(run, { visual: opts.visual, readOnlyTools: plan.readOnlyTools }) }
    : {};
  return JSON.stringify({ mcpServers: { ...clawbox, ...plan.servers } }, null, 2);
}

/** The run's own clawbox server entry. */
function runClawboxServer(run: { id: string; directory: string; media?: RunMedia; team?: RunTeam | null }, opts: { visual: boolean; readOnlyTools: boolean }) {
  // A run the diet judged NOT visual (src/lib/coding-diet.ts) holds neither the
  // browser family nor the media tools: its server is told so, and registers
  // only what is left (a team run's `team_message`). Omitted, today's server.
  const visual = opts.visual;
  const media = visual ? runMediaEnv(run.media) : "";
  return {
    command: path.join(homeDir(), ".bun", "bin", "bun"),
    args: ["run", path.join(CONFIG_ROOT, "mcp", "clawbox-mcp.ts")],
    env: {
      CLAWBOX_API_BASE: `http://127.0.0.1:${process.env.PORT || "80"}`,
      CLAWBOX_ROOT: CONFIG_ROOT,
      // `run-read` only for a project that ticked "ClawBox read-only
      // tools": the browser family as below, plus every readOnly tool.
      CLAWBOX_MCP_PROFILE: opts.readOnlyTools ? RUN_READ_PROFILE : "browser",
      CLAWBOX_RUN_ARTIFACTS_DIR: artifactsDir(run.id),
      // Where the assets this run was handed were staged. Named the same
      // way the evidence folder is, and for the same reason: the brief
      // talks about it, so it has to be one string the run can read rather
      // than a path it is expected to guess.
      CLAWBOX_RUN_INPUTS_DIR: runInputsDir(run.id),
      CLAWBOX_RUN_DIR: run.directory,
      ...(media ? { CLAWBOX_RUN_MEDIA: media } : {}),
      // Absent means the browser family registers, as it always has; "0"
      // is a run that holds none of it (mcp/lib/run-context.ts).
      ...(visual ? {} : { CLAWBOX_RUN_BROWSER: "0" }),
      // Only for a run of a coding team, and all four or none: the server
      // registers `team_message` from them (mcp/lib/run-context.ts), and
      // the tool speaks as THIS run — the route then checks the claim
      // against the team's board, so a variable is a name, not a pass.
      // `none` for the planner, whose run has no task of its own.
      ...(run.team
        ? {
            CLAWBOX_RUN_ID: run.id,
            CLAWBOX_TEAM_ID: run.team.id,
            CLAWBOX_TEAM_ROLE: run.team.role,
            CLAWBOX_TEAM_TASK: run.team.taskId ?? "none",
          }
        : {}),
    },
  };
}

/**
 * Does this run hold the browser and media tools? Always under the legacy
 * diet; under "auto", only a run judged visual. An undecided run errs on the
 * side of the tools. One rule for the argv and the run's MCP config file.
 */
export function runHoldsVisualTools(diet: CodingDiet, visual: boolean | null | undefined): boolean {
  return diet.visualTools === "always" || visual !== false;
}

/** What a run whose project opted into more MCP servers adds to its argv (spawnRun). */
export interface RunMcpArgs {
  /** The 0600 file writeRunMcpConfig wrote for this spawn. */
  configFile: string;
  /** The harness servers' approvals: `mcp__<server>` or `mcp__<server>__<tool>`. */
  allowedTools: readonly string[];
  /** What the harness's own exclude filters name. */
  disallowedTools: readonly string[];
  /** The run's server is in the `run-read` profile: approve MCP_READ_ONLY_TOOLS. */
  readOnlyTools: boolean;
}

/** What a run's argv — and its brief — are built from. */
export interface RunArgsOptions { resumeSessionId?: string | null; maxTurns?: number; effort?: CodingEffort; readOnly?: boolean; extraBrief?: string | null; experience?: string | null; reviewedSeparately?: boolean; draftPullRequests?: boolean; allowRules?: readonly string[]; provider?: CodingProvider; streamInput?: boolean; hookSettings?: string | null; cpuBudget?: number | null; runNotes?: string | null; lessonChannel?: boolean; run?: { id: string; directory: string; media?: RunMedia; team?: RunTeam | null };
  /** The token diet frozen on the run (CodingRun.diet); omitted = LEGACY_DIET, the pre-diet argv. */
  diet?: CodingDiet;
  /** The run's frozen visual decision (CodingRun.visual); only read under `visualTools: "auto"`. */
  visual?: boolean;
  /** The task talks about a pull request — the lean brief's auto-merge sentence. */
  pullRequestMentioned?: boolean;
  /**
   * The MCP servers the run's project opted into (src/lib/project-mcp-servers.ts).
   * Omitted — every run whose project ticked nothing — is today's argv, byte
   * for byte. Never for a read-only run.
   */
  mcp?: RunMcpArgs | null;
  /**
   * The run has no helper agents to delegate to — a Codex run (provider
   * `openai`), which has no `--agents`. Its brief says so instead of the
   * delegation sentence.
   */
  noHelpers?: boolean;
}

/**
 * The run's system prompt: the device's brief, then the project's run notes and
 * the lessons of earlier runs. Claude Code gets it as `--append-system-prompt`,
 * Codex as `developer_instructions` — one text, so the two runners are told the
 * same things. Exported for the contract test.
 */
export function buildRunSystemPrompt(opts: RunArgsOptions): string {
  const diet = opts.diet ?? LEGACY_DIET;
  const visual = runHoldsVisualTools(diet, opts.visual);
  // A run whose diff a separate review will read is told not to review it
  // twice — see REVIEWER_CLAUSE_SLOT. A team's run is told it never merges.
  const headless = headlessBrief({
    reviewedSeparately: opts.reviewedSeparately === true,
    team: Boolean(opts.run?.team),
    diet,
    visual,
    pullRequest: opts.draftPullRequests === true || opts.pullRequestMentioned === true,
    noHelpers: opts.noHelpers === true,
  });
  // The media the run actually holds: none for a run without the tools.
  const media = visual ? opts.run?.media : undefined;
  const brief = [
    // A read-only run has no Bash, no browser and no Write: the brief that
    // describes them would spend its steps on calls that are refused.
    opts.readOnly
      ? READ_ONLY_BRIEF
      : (opts.effort === ULTRACODE_EFFORT ? `${headless} ${ULTRACODE_BRIEF}` : headless),
    // Only for the run that HAS the tool: a brief that described a picture
    // tool to a run without one would spend steps on a call that is not there.
    // A read-only run holds no media tool either (runMcpTools is skipped for
    // it below), so it hears nothing about drawing or speaking.
    ...(media?.images && !opts.readOnly ? [MEDIA_BRIEF_IMAGES] : []),
    ...(media?.audio && !opts.readOnly ? [MEDIA_BRIEF_AUDIO] : []),
    ...(opts.draftPullRequests && !opts.readOnly ? [PR_DRAFT_BRIEF] : []),
    // The run's share of the CPU (src/lib/coding-run-cpu.ts). Not for a
    // read-only run: it runs no command, so it starts no build to cap.
    ...(typeof opts.cpuBudget === "number" && opts.cpuBudget >= 1 && !opts.readOnly ? [cpuBudgetBrief(opts.cpuBudget)] : []),
    // How a writing run adds a lesson to its project's run notes
    // (src/lib/coding-run-notes.ts); a read-only run cannot write one.
    ...(opts.lessonChannel && !opts.readOnly ? [LESSON_CHANNEL_BRIEF] : []),
    // A team's role for this run — the planner's "answer with a JSON array",
    // a worker's "this is your task among these" — after the device's own
    // words, never instead of them.
    ...(opts.extraBrief ? [opts.extraBrief] : []),
  ].join(" ");
  // The project's run notes (src/lib/coding-run-notes.ts) — what earlier runs
  // in this project learned and the owner kept — then the lessons from earlier
  // verified runs (src/lib/coding-experience.ts), last and on their own lines:
  // delimited blocks after every word of the device's own. In the system
  // prompt rather than the task, so the task stays what the caller typed. A
  // run given neither gets the brief above unchanged, byte for byte.
  return [brief, opts.runNotes, opts.experience].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** The argv handed to the wrapper. Exported for the contract test. */
export function buildRunArgs(opts: RunArgsOptions): string[] {
  const diet = opts.diet ?? LEGACY_DIET;
  // Does this run hold the browser and media tools? See runHoldsVisualTools.
  const visual = runHoldsVisualTools(diet, opts.visual);
  // The project's extra servers: a writing run's only (prepareRunMcp hands a
  // read-only run none, and this is the last place before argv).
  const mcp = opts.run && !opts.readOnly ? opts.mcp ?? null : null;
  const systemPrompt = buildRunSystemPrompt(opts);
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--setting-sources", "user",
    "--max-turns", String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    "--append-system-prompt", systemPrompt,
  ];
  // The task still travels on stdin either way; what this changes is the
  // SHAPE of what is written there and whether the pipe is closed behind it.
  // With it, the CLI goes on reading stdin for the life of the process, which
  // is what lets the owner tell a run something while it works
  // (src/lib/coding-run-messages.ts). Only valid alongside `-p` and
  // `--output-format stream-json`, both of which are above.
  if (opts.streamInput) args.push("--input-format", "stream-json");
  // Ultracode travels as a flag, the fixed levels through the wrapper's env
  // pin (see EFFORT_LEVELS). The wrapper would add the flag itself from the
  // owner's stored setting, but a run records the effort it STARTED with, and
  // a resume after the owner changed the setting must keep it.
  if (opts.effort === ULTRACODE_EFFORT) args.push("--effort", ULTRACODE_EFFORT);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.run) {
    // Exactly one MCP server — ours, in its browser-only profile. Strict, so
    // servers an owner configured for their own interactive claude-ds
    // sessions (~/.claude-ds) never leak into a delegated run.
    args.push("--strict-mcp-config");
    // A run without the visual tools that is not in a team has nothing left
    // for our server to register, so it gets no server at all — and the
    // strict flag alone still keeps the owner's own servers out.
    // A run whose project opted into more names the FILE holding them —
    // ours, plus the harness servers the owner ticked, with their
    // credentials, which is why it is not inline. The strict flag above
    // stays: still nothing the owner did not tick for THIS project.
    if (mcp) args.push("--mcp-config", mcp.configFile);
    else if (visual || opts.run.team) args.push("--mcp-config", buildRunMcpConfig(opts.run, { visual }));
    // acceptEdits only covers the working folder; without this, the run's own
    // Write into its evidence folder is denied — the brief's promise broken
    // (measured on run-yuyqta4t: pomodoro-verification.md refused).
    args.push("--add-dir", artifactsDir(opts.run.id));
  }
  // The run's hooks (src/lib/coding-run-inbox.ts): its inbox, read after every
  // tool call, and a team run's merge guard. Inline JSON, like the MCP config:
  // `--settings` is read whatever `--setting-sources` says.
  if (opts.hookSettings) args.push("--settings", opts.hookSettings);
  // The three tool flags are variadic and swallow any positional that follows,
  // which is why the task travels on stdin and these come last.
  args.push("--tools", opts.readOnly ? READ_ONLY_TOOLS : toolsFor(true, opts.effort));
  // The Agent tool with nothing to delegate to is a tool that never fires.
  // Per provider: the helper models named in the definitions are the cheap
  // tier of the account that answers, and the two accounts do not share a
  // model name between them (see HELPER_MODEL).
  args.push("--agents", JSON.stringify(subagentDefinitionsFor(opts.provider ?? DEFAULT_CODING_PROVIDER)));
  {
    // "Bash(*)" — allow EVERY command — rather than withholding the lists.
    // Withholding grants nothing: in headless -p mode the allow-list is what
    // approves a command, and with no list at all every Bash call just waits
    // for an approval nobody is there to give (verified on the box: curl was
    // still denied with the lists absent). The FILE rules still ship, and a
    // deny rule outranks any allow, so the credential stores stay closed.
    // Full access is about commands, not secrets.
    // The Workflow tool is listed AND pre-approved under ultracode: listed
    // alone it is refused headlessly (see WORKFLOW_TOOL).
    // A read-only run has no Bash to approve and no browser to drive: it
    // reads, and the helpers it delegates to read.
    // `Read(//tmp/**)`: a run may READ what it put in /tmp — the HTML it
    // curled out of its own server, a build log — without a permission
    // prompt it cannot answer in headless mode. Reads only, and only there:
    // the deny rules below still win for anything secret, and a write
    // outside the folder is still refused.
    // The owner's own rules come LAST, after everything the device ships, so
    // the built-in prefix stays where the contract tests expect it. Validated
    // again here rather than trusted: this is the last place before argv and it
    // is exported, so a caller that assembled a list by hand (a test, a future
    // surface) cannot put an unvetted string on a run's command line. An allow
    // rule only ever ADDS: every deny rule below still outranks it, which is
    // why a rule the device would refuse anyway is rejected at the door and
    // never stored.
    // With the HOME: `softProjectDir` anchors a soft path at it, so validating
    // with no context at all would drop exactly the harness-project rules this
    // feature exists to grant. The deny half cannot be passed here without
    // circularity — `fileDenyRules` below is built FROM this list — and does
    // not need to be: every deny rule it returns still outranks each allow.
    const allowRules = normalizeAllowRules(opts.allowRules, allowRuleHomeContext());
    // A team run's `team_message` is approved whatever else the run may do —
    // read-only included (see MCP_TEAM_TOOL) — and only for a team run.
    // The project's extra servers come right after the run's own MCP tools:
    // the read-only ClawBox tools by name, a harness server as a whole or by
    // the tools its own filter names.
    const mcpAllowed = mcp ? [...(mcp.readOnlyTools ? MCP_READ_ONLY_TOOLS : []), ...mcp.allowedTools] : [];
    args.push("--allowedTools", ...(opts.readOnly ? [] : ["Bash(*)"]), ...(opts.effort === ULTRACODE_EFFORT ? [WORKFLOW_TOOL] : []), ...(opts.run && !opts.readOnly && visual ? runMcpTools(opts.run.media) : []), ...(opts.run?.team ? [MCP_TEAM_TOOL] : []), ...mcpAllowed, TMP_READ_RULE, inputsReadRule(), ...allowRules);
    // The file rules, and the one command list that is enforced: nothing a
    // run runs may kill the box's own server by name (BASH_KILL_DENYLIST).
    //
    // The SAME rules the allow-list was built from, because a deny rule
    // outranks an allow rule: without handing them over here, an owner rule for
    // the harness's own project notes would sit in argv underneath the
    // wholesale `~/.claude-ds/**` deny and grant exactly nothing.
    // A harness server's exclude filter holds in the run too, and a deny
    // outranks the whole-server approval above.
    args.push("--disallowedTools", ...fileDenyRules(allowRules), ...(opts.readOnly ? [] : BASH_KILL_DENYLIST), ...(opts.run?.team && !opts.readOnly ? TEAM_MERGE_DENYLIST : []), ...(mcp?.disallowedTools ?? []));
  }
  return args;
}

/**
 * WHICH project a run belongs to, for the secret store's scope.
 *
 * The same identity the projects listing gives a row (`CodingProject.folder`),
 * derived the same way: a code project's id, else the FIRST folder under the
 * owner's project folder that the run's directory sits in — at any depth, which
 * is how a run in `~/Projects/shop/api` gets the `shop` project's secrets.
 *
 * Deliberately NOT `run.projectId`, which is set only for a code project: a
 * scope keyed on it would have left every folder project — the kind the owner's
 * own project folder holds — unable to have a secret of its own.
 *
 * Null when the run is in no project of the owner's (a bare absolute folder, or
 * a box with no project folder set). Such a run gets the box-scoped entries
 * alone; it is not a project, so no project's secrets are its own.
 */
async function projectScopeFor(run: Pick<CodingRun, "projectId" | "directory">): Promise<string | null> {
  if (typeof run.projectId === "string" && run.projectId) return run.projectId;
  if (typeof run.directory !== "string" || !run.directory) return null;
  const folders = await readProjectFolders();
  if (!folders) return null;
  // Both spellings of the base, the way listProjects matches them: a run
  // records its folder symlink-resolved, and the owner's setting may not be.
  const realBase = await fs.promises.realpath(folders.base).catch(() => folders.base);
  for (const base of new Set([folders.base, realBase])) {
    if (!run.directory.startsWith(base + path.sep)) continue;
    const first = path.relative(base, run.directory).split(path.sep)[0];
    // A dot-folder is state, not a project — the same cut listProjects makes.
    if (first && !first.startsWith(".")) return first;
  }
  return null;
}

/**
 * The plaintext an in-flight run holds, keyed by run id.
 *
 * IN MEMORY, never on the record and never persisted: the run record goes to
 * `data/coding-agent-runs.json` and is answered by a route the MCP bearer
 * reaches, and the whole point of the store is that the value is not lying
 * about in a file. What DOES go on the record is the NAMES
 * (`CodingRun.secretNames`), which the owner's page shows and the agent may
 * already list.
 *
 * Filled by `prepareRunSecrets` on the async path just before each spawn — the
 * resolve is a disk read and `spawnRun` is synchronous — and dropped by
 * `cleanupRunResources` when the run settles. A resume re-resolves rather than
 * reusing what is here, so an entry the owner has since un-ticked is not handed
 * back to a run that already had it.
 */
const runSecretEnv = store.runSecretEnv;

/**
 * The scope each injected name's value came from, by run id — names and scopes
 * only, for the hand-off's audit line (`auditRunHandOff`). Set with the values
 * by `prepareRunSecrets` and, unlike them, kept through a settle: the transient
 * retry and the account switch respawn with the carried values, and their
 * hand-off is filed under the same scopes. Dropped when the run ends
 * (`endRunSecrets`).
 */
const runSecretScopes: Map<string, Record<string, string>> =
  store.runSecretScopes ?? (store.runSecretScopes = new Map<string, Record<string, string>>());

/**
 * Run id → when each DATED copy it was handed stops being handed, as the resolve
 * read it (`ResolvedRunSecrets.expiresAt`). For the transient retry alone, which
 * respawns from the child's `close` handler and cannot re-read the store the way
 * the account switch does (`withoutExpiredSecrets`). Dropped with the scopes.
 */
const runSecretExpiry: Map<string, Record<string, number>> =
  store.runSecretExpiry ?? (store.runSecretExpiry = new Map<string, Record<string, number>>());

/** Statuses a run can still be handed its one-run secrets in (again). */
const SECRET_HOLDING_STATUSES: ReadonlySet<CodingRunStatus> = new Set(["running", "paused", "queued", "draft"]);

/** True while a run may still use what it was handed: in flight, or held to resume. */
function isRunGoing(runId: string): boolean {
  if (runSecretEnv.has(runId) || live.has(runId)) return true;
  const run = loadRuns().find((r) => r.id === runId);
  return run !== undefined && SECRET_HOLDING_STATUSES.has(run.status);
}

/**
 * The run is over — finished, failed, stopped, or never started — so the copies
 * the owner limited to it go from the store, with their audit line. Tracked
 * settle work: the store write is asynchronous and must not be lost to a reset.
 */
function endRunSecrets(run: CodingRun): void {
  runSecretScopes.delete(run.id);
  runSecretExpiry.delete(run.id);
  trackSettleWork(releaseRunSecrets((runId) => runId === run.id));
}

/** What one spawn's environment carries of the owner's secrets: names and scopes, never a value. */
interface RunHandOff {
  names: string[];
  scopes: Record<string, string>;
}

/** Taken just before the spawn: by the time its outcome is known, a failed child's settle has dropped the tables. */
function runHandOffOf(runId: string): RunHandOff | null {
  const names = Object.keys(runSecretEnv.get(runId) ?? {});
  return names.length ? { names, scopes: { ...(runSecretScopes.get(runId) ?? {}) } } : null;
}

/**
 * The hand-off's audit line, once it is known: written when the child has
 * actually started ("inject"), or when it failed to ("not_handed"). Before that
 * nothing was handed — the resolve alone is not a hand-off. Nothing is written
 * for a spawn that carried none.
 */
function auditRunHandOff(runId: string, handOff: RunHandOff | null, handed: boolean): void {
  if (!handOff) return;
  trackSettleWork(recordRunSecretsHanded({ runId, ...handOff, handed }));
}

/**
 * For a caller whose `spawnRun` THREW: "not handed", unless a child had already
 * been registered (`live`), whose own "spawn" or "error" event says it instead.
 * A throw anywhere before the child exists — the stream logs, the environment,
 * the credential handoff, `spawn` itself — reaches the caller this way. Called
 * before the caller drops the run's tables, while the names are still there.
 */
function auditUnstartedSpawn(runId: string): void {
  if (!live.has(runId)) auditRunHandOff(runId, runHandOffOf(runId), false);
}

/**
 * Work out what this run may have, put it where the spawn can reach it, and
 * arm the redaction table for everything the run will say.
 *
 * Awaited by every caller before `spawnOrSettle`, and the ONE place those two
 * facts are set together: an environment armed without the redaction table
 * would hand a run a token and then print it.
 */
async function prepareRunSecrets(run: CodingRun): Promise<ResolvedRunSecrets> {
  // A one-run copy whose run ended while this server was not there to see it
  // (a restart mid-run, a start that threw before its spawn) goes before
  // anything is handed out. Never this run's own: it may be resuming with it.
  await releaseRunSecrets((runId) => runId !== run.id && !isRunGoing(runId)).catch((err) => {
    console.error("[coding-agent] could not clear spent one-run secrets:", err instanceof Error ? err.message : err);
  });
  const project = await projectScopeFor(run);
  const resolved = await resolveSecretsForRun({ project, runId: run.id });
  runSecretEnv.set(run.id, resolved.env);
  runSecretScopes.set(run.id, resolved.scopes);
  runSecretExpiry.set(run.id, resolved.expiresAt);
  // The Anthropic account rides the same path: every async spawn comes through
  // here just before it, which is exactly where "which account is first in
  // line right now" should be asked (TASK-902).
  await prepareRunAccount(run);
  // …and the OpenAI key, for an `openai` run.
  await prepareRunOpenAIKey(run);
  // …and the project's MCP servers, whose credentials the table below must
  // know before the child that holds them exists.
  await prepareRunMcp(run, project);
  registerRunRedaction(run.id);
  run.secretNames = resolved.names;
  if (resolved.names.length > 0) pushProgress(run, RUNNER_STEP.secretsInjected(resolved.names));
  // Said in the run's own feed rather than only in the log: an entry the owner
  // ticked and this box cannot open is a run working without a credential it
  // was meant to have, and the failure it causes looks like anything else.
  if (resolved.unreadable.length > 0) pushProgress(run, RUNNER_STEP.secretsUnreadable(resolved.unreadable));
  return resolved;
}

/**
 * The Anthropic account a run's next spawn is on, WITH its credential — in
 * memory only, beside the owner's secrets and dropped with them, never on the
 * record (which carries the account's id and nothing else).
 */
interface RunAnthropicCredential {
  accountId: string;
  label: string;
  credential: AnthropicCredential;
}

const runAnthropicCredential: Map<string, RunAnthropicCredential> =
  store.runAnthropicCredential ?? (store.runAnthropicCredential = new Map<string, RunAnthropicCredential>());

/**
 * The owner's OpenAI API key for an `openai` run's next spawn — in memory only,
 * beside the owner's secrets and dropped with them, never on the record. No
 * entry is a run on the ChatGPT sign-in in the coding agent's CODEX_HOME.
 */
const runOpenAIKey: Map<string, string> =
  store.runOpenAIKey ?? (store.runOpenAIKey = new Map<string, string>());

/**
 * The MCP servers a run's project opted into (src/lib/project-mcp-servers.ts),
 * WITH the env and header values its config file carries — in memory beside
 * the owner's secrets, dropped with them, never on the record, which names the
 * servers in the run's feed and nothing else.
 */
const runMcpPlan: Map<string, RunMcpPlan> =
  store.runMcpPlan ?? (store.runMcpPlan = new Map<string, RunMcpPlan>());

/** How the run's feed names an allowlist entry. */
function mcpEntryLabel(name: string): string {
  return name === CLAWBOX_READ_ONLY_ENTRY ? "ClawBox read-only tools" : name;
}

/**
 * Read what this run's project ticked, against what this box's harness is
 * configured with right now. Re-read at every spawn, like the secrets: a
 * resume does not hand back a server the owner has since un-ticked.
 *
 * Never throws, and fails CLOSED: anything that cannot be read is a run with
 * exactly today's tools. A read-only run gets none of it — it has no Bash, no
 * Write and no browser, and a third-party server's own "read-only" hint is not
 * something this box can check.
 */
async function prepareRunMcp(run: CodingRun, project: string | null): Promise<void> {
  runMcpPlan.delete(run.id);
  if (run.readOnly) return;
  let plan: RunMcpPlan | null = null;
  try {
    plan = await resolveRunMcpPlan(project);
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: the project's MCP servers could not be read:`, err instanceof Error ? err.message : err);
  }
  if (!plan) return;
  // A Codex run is handed its MCP servers in argv (buildCodexRunArgs), which
  // is world-readable: the ClawBox read-only tools travel (they carry no
  // secret), the harness servers and their credentials do not — and the feed
  // says which, rather than leaving the owner to wonder where a tool went.
  if (runsOnCodex(run.provider)) {
    const unavailable = Object.keys(plan.servers);
    if (unavailable.length > 0) pushProgress(run, RUNNER_STEP.mcpServersMissing(unavailable.map(mcpEntryLabel)));
    if (!plan.readOnlyTools) return;
    plan = { ...plan, servers: {}, names: plan.names.filter((n) => !unavailable.includes(n)), secrets: [], allowedTools: [], disallowedTools: [] };
  }
  if (plan.names.length > 0) {
    runMcpPlan.set(run.id, plan);
    pushProgress(run, RUNNER_STEP.mcpServers(plan.names.map(mcpEntryLabel)));
  }
  if (plan.missing.length > 0) pushProgress(run, RUNNER_STEP.mcpServersMissing(plan.missing.map(mcpEntryLabel)));
}

/**
 * Choose the account for an `anthropic` run's next spawn: the first usable one
 * in the owner's order (src/lib/anthropic-accounts.ts).
 *
 * Never throws: this runs after a record may already have been flipped to
 * "running". When the pool cannot be read, or holds nothing that answers, the
 * spawn goes without a handoff and the wrapper falls back to what it always
 * read (the legacy key, else the `claude` sign-in) — and when every account is
 * limited the preferred one is handed over anyway (`fallback`), because its
 * refusal is what pauses the run until the reset.
 */
async function prepareRunAccount(run: CodingRun): Promise<void> {
  runAnthropicCredential.delete(run.id);
  if (run.provider !== "anthropic") return;
  // A run on the pool is a consumer of its active account, boot hook or not.
  armCodingSwapConsumer();
  let prepared: PreparedAccount | null = null;
  try {
    ({ prepared } = await prepareAccount({ fallback: true }));
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: the Anthropic account pool could not be read:`, err instanceof Error ? err.message : err);
  }
  if (!prepared) return;
  runAnthropicCredential.set(run.id, { accountId: prepared.account.id, label: prepared.account.label, credential: prepared.credential });
  if (run.anthropicAccount !== prepared.account.id) pushProgress(run, RUNNER_STEP.anthropicAccount(prepared.account.label));
  run.anthropicAccount = prepared.account.id;
}

/**
 * The OpenAI key for an `openai` run's next spawn, when the owner saved one.
 * Never throws: a store that cannot be read leaves the run on the ChatGPT
 * sign-in, and Codex says so if there is none.
 */
async function prepareRunOpenAIKey(run: CodingRun): Promise<void> {
  runOpenAIKey.delete(run.id);
  if (!runsOnCodex(run.provider)) return;
  try {
    const key = await readOpenAIKey();
    if (key) runOpenAIKey.set(run.id, key);
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: the OpenAI key could not be read:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Arm the redaction table with everything this run was handed: the owner's
 * injected secrets, and the Anthropic account's own token or key — which is in
 * the harness's environment too, so a run that echoes it must not get it onto
 * the record.
 */
function registerRunRedaction(runId: string): void {
  const list = Object.entries(runSecretEnv.get(runId) ?? {}).map(([name, value]) => ({ name, value }));
  const account = runAnthropicCredential.get(runId);
  if (account?.credential.secret) list.push({ name: "ANTHROPIC_ACCOUNT", value: account.credential.secret });
  const openaiKey = runOpenAIKey.get(runId);
  if (openaiKey) list.push({ name: "OPENAI_API_KEY", value: openaiKey });
  // Every env and header value of the project's MCP servers: the run holds
  // them through its config file, and one it echoes must not reach the record.
  list.push(...(runMcpPlan.get(runId)?.secrets ?? []));
  registerRunSecrets(runId, list);
}

/**
 * Put a run's secrets back, from a copy taken before its settle dropped them.
 *
 * For the two continuations that respawn the same record from its own settle:
 * the automatic transient retry in `finishRun`, which runs synchronously from
 * the child's `close` handler and cannot re-resolve (the resolve is a disk
 * read), and the account switch, which re-resolves only the ACCOUNT. The
 * cleanup above both has already emptied every table. A retried child spawned
 * with no redaction table armed is a child whose echoed token would reach the
 * run record; one spawned with no environment is a retry that fails for the
 * want of a credential the first attempt had.
 *
 * Every OTHER continuation is asynchronous and re-resolves instead
 * (`prepareRunSecrets`): the owner's Resume, a drafted run, and each attempt of
 * the deliverable gate. Those are the paths where re-reading is the right
 * answer, because time has passed and the owner may have changed their mind.
 */
function restoreRunSecrets(runId: string, env: Record<string, string>, account?: RunAnthropicCredential, mcp?: RunMcpPlan, openaiKey?: string): void {
  runSecretEnv.set(runId, env);
  if (account) runAnthropicCredential.set(runId, account);
  if (openaiKey) runOpenAIKey.set(runId, openaiKey);
  if (mcp) runMcpPlan.set(runId, mcp);
  registerRunRedaction(runId);
}

/** Every table, emptied for one run. The settle path's own step, and the undo
 *  for a `restoreRunSecrets` whose child never started. */
function dropRunSecrets(runId: string): void {
  runSecretEnv.delete(runId);
  runAnthropicCredential.delete(runId);
  runOpenAIKey.delete(runId);
  runMcpPlan.delete(runId);
  forgetRunSecrets(runId);
}

/**
 * The environment a run gets — and nothing else. Exported for the contract test.
 *
 * The PROVIDER travels here and the credential does not: the wrapper reads
 * whichever secret its provider needs out of the box's own 0600 config, so
 * neither the ClawBox AI portal token nor the owner's Anthropic key is ever in
 * this object, in the web server's `spawn` call, or in the child's argv. What
 * the two providers must not share is handled on the other side of the fence
 * (scripts/claude-ds unsets the whole of the other wiring); this side's job is
 * to name one of them and to pass no stale override that could contradict it.
 */
/**
 * scripts/clawbox-preview.mjs — the bounded loopback preview server a run uses
 * to LOOK at what it built. In the checkout, like every other script the device
 * hands a run.
 */
export function previewScriptPath(): string {
  return path.join(CONFIG_ROOT, "scripts", "clawbox-preview.mjs");
}

export function buildRunEnv(opts: { effort?: CodingEffort; artifactsDir?: string; inputsDir?: string; provider?: CodingProvider; model?: string | null; cpuBudget?: number | null; secrets?: Record<string, string>; diet?: CodingDiet | null } = {}): Record<string, string> {
  const home = homeDir();
  const user = process.env.USER || process.env.LOGNAME || path.basename(home);
  const env: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: runnerPath(),
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CLAWBOX_ROOT: CONFIG_ROOT,
    // No update checks, no telemetry: the appliance may be offline, and a run
    // that stalls on a version check is a run that looks hung.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  // The device's own overrides for the wrapper, when the owner set them.
  for (const key of ["CLAWBOX_AI_PROXY_URL", "CLAUDE_DS_MODEL", "CLAUDE_DS_SMALL_MODEL", "CLAUDE_DS_EFFORT", "CLAUDE_DS_CONFIG_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  // The owner's setting wins over anything inherited: this is the knob the
  // Coding Agent app writes, and a stale shell variable must not override it.
  if (opts.effort) env.CLAUDE_DS_EFFORT = opts.effort;
  // The diet's context cap (src/lib/coding-diet.ts): compact near this window
  // instead of the model's own, which on a 1M-token model is never reached.
  if (opts.diet?.context === "capped") env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(CONTEXT_CAP_WINDOW);
  // Which account pays. Always written, never left to whatever the web
  // server's own environment happens to carry: an inherited CLAUDE_DS_PROVIDER
  // would decide who is billed for a run nobody asked to move.
  const provider = opts.provider ?? DEFAULT_CODING_PROVIDER;
  env.CLAUDE_DS_PROVIDER = provider;
  // The run's model, frozen on its record. It overrides the loop above for the
  // same reason the effort does — and on a provider that chooses its own model
  // the inherited override is DROPPED rather than passed through, because a
  // CLAUDE_DS_MODEL left in the environment for one provider is a model name
  // the other does not serve.
  if (opts.model) env.CLAUDE_DS_MODEL = opts.model;
  else if (modelsForProvider(provider).length > 0) delete env.CLAUDE_DS_MODEL;
  // An `openai` run is the Codex CLI: none of the wrapper's knobs mean
  // anything to it, and its state lives in the coding agent's own CODEX_HOME
  // (src/lib/coding-openai.ts) — set here, ahead of the owner's secrets, so no
  // stored secret can point a run's Codex at another home and another login.
  if (runsOnCodex(provider)) {
    for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_") || key === "CLAWBOX_AI_PROXY_URL") delete env[key];
    env.CODEX_HOME = codexHome();
  }
  // The run's evidence folder — the brief tells the run to save proof of its
  // work here, and the browser MCP layer saves screenshots into it.
  if (opts.artifactsDir) env.CLAWBOX_RUN_ARTIFACTS_DIR = opts.artifactsDir;
  // The folder holding the files this run was GIVEN. A CLAWBOX_ name, which
  // `setSecret` refuses, so the owner's secret store cannot repoint a run's
  // inputs at something else — the same reason CLAWBOX_PREVIEW is one.
  if (opts.inputsDir) env.CLAWBOX_RUN_INPUTS_DIR = opts.inputsDir;
  // How a run turns its own folder into a page the device browser can open.
  // Named here rather than written into the brief as a literal path so the
  // review pass and the brief cannot disagree about where the script is — and
  // it is a CLAWBOX_ name, which setSecret refuses, so the owner's secret store
  // cannot point a run's preview at something else. See previewScriptPath.
  env.CLAWBOX_PREVIEW = previewScriptPath();
  // How many parallel jobs the run's builds and tests may start
  // (src/lib/coding-run-cpu.ts) — the number its brief tells it to pass to
  // `--maxWorkers` and `-j`. A CLAWBOX_ name, so no stored secret can raise it.
  if (typeof opts.cpuBudget === "number" && Number.isInteger(opts.cpuBudget) && opts.cpuBudget >= 1) {
    env[RUN_CPU_BUDGET_ENV] = String(opts.cpuBudget);
  }
  // The owner's secrets, LAST and never over the top of anything above.
  //
  // Resolved by the caller (`prepareRunSecrets`) because it is a disk read and
  // this function is synchronous — and gated three times before it gets here:
  // the owner's switch, the entry's own tick, and the scope (project-secrets.ts).
  //
  // The two guards here are defence in depth, not the fence. `setSecret`
  // refuses a reserved name at save time, so neither can fire today; they are
  // what makes this loop safe to read on its own, and what covers a store
  // written by an older build. `in env` is checked rather than assigned over,
  // because everything above decides which account pays for the run, where its
  // evidence goes and what its PATH is — an entry that could overwrite one of
  // those would be a way to move a run onto another account by saving a
  // "secret".
  for (const [name, value] of Object.entries(opts.secrets ?? {})) {
    if (name in env) continue;
    if (!SECRET_NAME_RE.test(name) || isReservedSecretName(name)) continue;
    env[name] = value;
  }
  // On an `openai` run, the variable `codex exec` authenticates with is the
  // box's to set, from the owner's saved key (spawnRun) — never an owner
  // secret that happens to carry the name, which would move the run onto
  // another bill. A Claude run's harness never reads it.
  if (runsOnCodex(provider)) delete env[CODEX_API_KEY_ENV];
  return env;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * One signal to whatever is left of a run: its child's process group when this
 * server spawned it, or the recorded group when it was reattached after a
 * restart and there is no child object to ask.
 */
function signalRun(state: LiveRun, signal: NodeJS.Signals): void {
  if (state.child) {
    killTree(state.child, signal);
    return;
  }
  if (!state.pgid) return;
  try {
    process.kill(-state.pgid, signal);
  } catch {
    // already gone, which is the outcome wanted
  }
}

/**
 * SIGTERM now, SIGKILL after the grace period if the tree is still there.
 *
 * The SCOPE first, when the run has one: stopping the unit ends the whole
 * cgroup, which reaches a grandchild that put itself in another process group
 * and so slipped past the signal. Signals still follow, because systemd may not
 * answer and a direct-spawn run has no unit to stop.
 */
function endProcess(state: LiveRun): void {
  if (state.unit) void stopUnit(state.unit).catch(() => {});
  signalRun(state, "SIGTERM");
  if (state.killTimer) clearTimeout(state.killTimer);
  state.killTimer = setTimeout(() => signalRun(state, "SIGKILL"), STOP_GRACE_MS);
  state.killTimer.unref();
}

/**
 * Is anything still alive in this process group? Signal 0 delivers nothing and
 * only asks the question — EPERM would mean "there, but not ours", which on a
 * box where every run is the same user does not happen and is still not "gone".
 */
function groupAlive(pgid: number | null): boolean {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait, at most `ms`, for a process group to be gone; answers whether it is.
 * For a group the settle has just signalled: SIGKILL follows STOP_GRACE_MS
 * after the SIGTERM (killRunGroup), so a little longer than that is enough.
 */
async function groupGone(pgid: number | null, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Is that ONE process still there? `groupAlive`'s narrower sibling, and the two
 * answer different questions: the group is alive while anything the run forked
 * is, the process is alive only while the HARNESS is.
 */
function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * End a settled run's process group by its recorded pgid — the escalation the
 * kill path uses when nothing the run left is wanted, and the same thing the
 * owner's Kill button asks for on a run that deliberately left a server.
 *
 * Answers whether anything was there to signal. Never throws: this runs on the
 * settle path, where a failure to clean up must not change what the record says
 * about the run.
 */
export function killRunGroup(pgid: number | null): boolean {
  if (!groupAlive(pgid)) return false;
  const group = pgid as number;
  try {
    process.kill(-group, "SIGTERM");
  } catch {
    return false;
  }
  const hard = setTimeout(() => {
    try {
      if (groupAlive(group)) process.kill(-group, "SIGKILL");
    } catch {
      // gone between the check and the signal — which is the outcome wanted
    }
  }, STOP_GRACE_MS);
  hard.unref();
  return true;
}

/**
 * Everything a settled run holds that is not its record: the browser tab it
 * opened, its timers, and whatever it left running.
 *
 * The process group is the one decision here that is not obvious. On a NATURAL
 * standalone completion it is deliberately left alone: the orientation guide tells a run
 * to leave its server listening so the app it built can be reached from the
 * desktop, and a settle that killed the group would break exactly the pattern
 * the device documents. So a finished run RECORDS what survived and the run's
 * page offers to end it; only an outcome where nothing the run left is wanted —
 * stopped, failed, timed out — escalates to the kill. Team roles also end
 * their owned group on success: no per-worker preview may outlive integration.
 */
function cleanupRunResources(run: CodingRun, state: LiveRun | null): void {
  if (state) {
    // Nothing more can be written to a harness that has gone: a message that
    // arrives after this waits for the next attempt or the owner's Resume.
    closeRunStdin(state);
    clearInterval(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
    if (state.streamTimer) clearInterval(state.streamTimer);
    if (state.unitWatch) clearInterval(state.unitWatch);
    state.streamTimer = null;
    state.unitWatch = null;
  }
  // The box's own plumbing, not evidence: the tail has been read by now, and a
  // log kept past the settle is disk the owner never asked to spend. A retry
  // (finishRun) opens a fresh pair. EXCEPT under the archive mode, where the
  // owner did ask: the log waits beside the run and goes into the archive with
  // it (dropRun moves it there, or deletes it with the run's other parts).
  if (store.historyPolicy?.mode !== "archive") removeStreamLogs(run.id);
  // A credential handoff the wrapper never got to read (it died first, or
  // never started) goes with the process it was written for.
  removeCredentialHandoffs(run.id);
  // …and so does the MCP config file with the project's server credentials.
  removeRunMcpConfigs(run.id);
  // The run's own tab, never the owner's: browser sessions are tagged with the
  // run that opened them and a run always gets a new page (browser-sessions.ts).
  void closeSessionsForRun(run.id).catch(() => {});
  // The owner's secrets, out of memory the moment the run is over — including
  // for a PAUSED run, which re-resolves them on resume rather than being handed
  // back an entry the owner has since un-ticked. Nothing written after this
  // point can contain a value: the child is gone, and `secretNames` on the
  // record is names only.
  dropRunSecrets(run.id);
  if ((run.status === "completed" && !run.team) || run.status === "paused") {
    run.leftover = groupAlive(run.pgid);
    if (run.leftover) {
      pushProgress(run, RUNNER_STEP.leftoverRunning);
      return;
    }
    // The group is gone, and the number that named it is now the kernel's to
    // hand to anybody. Forget it here for the same reason reconcileAfterRestart
    // forgets it across a restart: a record that keeps a recycled pid would let
    // the Kill button signal a stranger's process group in this run's name.
    // The scope goes with it: nothing is in it, so `--collect` has taken it.
    run.pgid = null;
    run.unit = null;
    return;
  }
  run.leftover = false;
  // The scope as well as the group: `--collect` removes a scope once its last
  // process is gone, so a unit left active here is a unit with something in it.
  if (run.unit) void stopUnit(run.unit).catch(() => {});
  if (killRunGroup(run.pgid)) {
    pushProgress(run, RUNNER_STEP.endedLeftovers);
  }
  run.pgid = null;
  run.unit = null;
}

/**
 * The owner's Kill button: end whatever a settled run left behind.
 *
 * Only a settled run — a live one is Stop's business, and stopping is what
 * that gesture already means. A PAUSED run is refused for the opposite reason:
 * it is still the owner's to resume, and what it left listening is likely the
 * very thing the resumed run carries on against. Idempotent: a group that is
 * already gone answers `killed: false` rather than an error, because "nothing
 * is running" is the state the caller wanted either way.
 */
export function killRunLeftovers(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (isLive(run.status)) {
    throw new CodingAgentError("invalid", "That run is still going. Stop it instead; stopping ends everything it started.");
  }
  if (isHeld(run.status)) {
    throw new CodingAgentError("invalid", "That run is paused, not finished. Resume it, or stop it first.");
  }
  // The scope takes the whole cgroup with it, which is what reaches a server the
  // run forked into a process group of its own. The signal follows regardless.
  if (run.unit) void stopUnit(run.unit).catch(() => {});
  if (killRunGroup(run.pgid)) pushProgress(run, RUNNER_STEP.ownerEndedLeftovers);
  run.leftover = false;
  // Signalled or already gone, the group this record named is finished with.
  // Keeping the number would leave a Kill button aimed at whatever the kernel
  // gives that pid to next.
  run.pgid = null;
  run.unit = null;
  persist(true);
  return cloneRun(run);
}

/**
 * The paths a prune removed, as the value of one progress line: a tree with a
 * trailing slash, a link as it is. The first four by name, then a count — the
 * feed caps a line, and four is what fits after the sentence.
 */
function prunedPaths(pruned: PrunedArtifact[]): string {
  const names = pruned.map((p) => (p.reason === "interpreter" ? `${p.path}/` : p.path)).sort();
  const shown = names.slice(0, 4).join(", ");
  return names.length > 4 ? `${shown} (+${names.length - 4})` : shown;
}

function pushProgress(run: CodingRun, line: string): void {
  // Scrubbed FIRST, before the collapse and the cap: this feed is persisted on
  // the run record and answered by a route the MCP bearer reaches, and a tool
  // name or an agent sentence is exactly where an echoed token turns up. A cap
  // applied first could also cut a value in half and leave the front of it in
  // the line unmatched. No-op on every run that holds no secrets.
  const cleaned = redactForRun(run.id, line).replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  run.progress.push(cleaned.length > MAX_PROGRESS_LINE_CHARS ? `${cleaned.slice(0, MAX_PROGRESS_LINE_CHARS - 1)}…` : cleaned);
  // When it happened, kept in step with the line: the timeline shows it on hover.
  run.progressAt.push(Date.now());
  trimProgress(run);
}

/** The marker's own shape, read back so a second trim adds to its count rather than stacking markers. */
const DROPPED_RE = /^… (\d+) earlier steps are not kept$/;

/**
 * Hold the feed at PROGRESS_KEEP entries by dropping from the MIDDLE — the
 * run's first steps and its newest both survive, and the gap between them is
 * a line saying how many went.
 *
 * Times stay one for one with lines (the timeline draws nothing when they do
 * not), and the marker is stamped with the last dropped line's time, so the
 * step after the gap still reads as "and then, later, this".
 */
function trimProgress(run: { progress: string[]; progressAt: number[] }): void {
  if (run.progressAt.length > run.progress.length) run.progressAt.splice(0, run.progressAt.length - run.progress.length);
  if (run.progress.length <= PROGRESS_KEEP) return;
  const timed = run.progressAt.length === run.progress.length;
  const head = run.progress.slice(0, PROGRESS_HEAD_KEEP);
  const headAt = timed ? run.progressAt.slice(0, PROGRESS_HEAD_KEEP) : [];
  const rest = run.progress.slice(PROGRESS_HEAD_KEEP);
  const restAt = timed ? run.progressAt.slice(PROGRESS_HEAD_KEEP) : [];
  // A marker already sitting at the boundary is this run's earlier gap, not a
  // step: its count is carried forward and it is written afresh below.
  const carried = DROPPED_RE.exec(rest[0] ?? "");
  let dropped = 0;
  let gapAt = timed ? headAt[headAt.length - 1] : 0;
  if (carried) {
    dropped = Number(carried[1]);
    rest.shift();
    if (timed) gapAt = restAt.shift() ?? gapAt;
  }
  const tailKeep = PROGRESS_KEEP - PROGRESS_HEAD_KEEP - 1;
  if (rest.length > tailKeep) {
    const cut = rest.length - tailKeep;
    dropped += cut;
    rest.splice(0, cut);
    if (timed) gapAt = restAt.splice(0, cut)[cut - 1] ?? gapAt;
  }
  run.progress = [...head, RUNNER_STEP.dropped(dropped), ...rest];
  run.progressAt = timed ? [...headAt, gapAt, ...restAt] : [];
}

/** Staging a 200-step run through the harness is not a unit test; the trim is. */
export const trimProgressForTests = trimProgress;

function relativeToRun(run: CodingRun, file: unknown): string | null {
  if (typeof file !== "string" || !file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(run.directory, file);
  return isInside(abs, run.directory) ? path.relative(run.directory, abs) || "." : abs;
}

function noteFile(run: CodingRun, file: string | null): void {
  if (!file || run.filesTouched.includes(file)) return;
  run.filesTouched.push(file);
}

/** What a media route learns when it asks for one of the run's slots. */
export type MediaReservation =
  | { ok: true; used: number; cap: number }
  | { ok: false; reason: "no_run" | "cap"; used: number; cap: number };

/**
 * Take one of the LIVE run's slots for `kind`, or refuse because they are all
 * spent — or because there is no longer a run to spend them.
 *
 * The counter moves HERE, before the generator is called, and not once the
 * bytes come back. The routes spend the owner's ClawBox AI allowance and the
 * box's voice between the two moments — seconds of it, when a clip waits in
 * withSpeechQueue — so a cap read from a snapshot and incremented afterwards
 * let two overlapping calls both pass a gate that had room for one. This
 * function is synchronous from the read to the write, which is what makes
 * "both passed" impossible; releaseRunMedia hands the slot back when nothing
 * was produced with it.
 */
export function reserveRunMedia(runId: string, kind: keyof RunMedia): MediaReservation {
  const cap = kind === "images" ? MAX_IMAGES_PER_RUN : MAX_AUDIO_PER_RUN;
  const run = loadRuns().find((r) => r.id === runId);
  // A stale bearer must not spend a settled record's allowance, and a run that
  // ended between the route's first look and this one is the same case.
  if (!run || !isLive(run.status)) return { ok: false, reason: "no_run", used: 0, cap };
  const used = run.mediaGenerated[kind];
  if (used >= cap) return { ok: false, reason: "cap", used, cap };
  run.mediaGenerated[kind] = used + 1;
  persist(true);
  return { ok: true, used: used + 1, cap };
}

/**
 * Hand back a slot the caller took and did not spend.
 *
 * Deliberately NOT live-gated, unlike the reservation: this only returns what
 * reserveRunMedia took while the run was live, and a run that settled while
 * its generator was working must not be left recorded as having used a
 * picture nobody ever drew.
 */
export function releaseRunMedia(runId: string, kind: keyof RunMedia): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run || run.mediaGenerated[kind] <= 0) return;
  run.mediaGenerated[kind] -= 1;
  persist(true);
}

/**
 * Record the file a media route just wrote for the LIVE run.
 *
 * The routes write it themselves, so nothing in the stream ever mentions it:
 * without this the run's changed-files list would omit the very assets the
 * owner is about to look at. The COUNTER is not touched here — reserveRunMedia
 * moved it before anything was spent, which is the only point at which two
 * overlapping calls cannot both pass one cap. Silent for anything that is not
 * the live run: a write that lands after the run settled — the audio route can
 * wait seconds in withSpeechQueue — must not edit a finished record.
 */
export function noteRunMedia(runId: string, file: string | null, meter?: CodingPauseMeter): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run || !isLive(run.status)) return;
  // A meter that just produced a file is not the meter that is spent, so an
  // earlier refusal of it stops being an account of anything. Without this a
  // run refused once at 10:00 and served happily at 10:01 could still have a
  // 10:02 pause blamed on an allowance it plainly has.
  const state = live.get(runId);
  if (state?.allowanceRefusal && (meter === undefined || state.allowanceRefusal.meter === meter)) {
    state.allowanceRefusal = null;
  }
  // Evidence is listed with the run in its own right, and counting it as work
  // made a review pass that changed nothing report a changed file and arm a
  // review of no work — the same reason the stream parser skips it.
  if (file && !isEvidencePath(run, file)) noteFile(run, relativeToRun(run, file));
  persist(true);
}

/**
 * How long a refusal may explain a pause that follows it.
 *
 * A run refused for allowance is told not to retry, tidies up and settles
 * within a turn; two minutes covers that with room for a slow final turn
 * without stretching to cover an unrelated pause an hour later.
 */
export const PAUSE_AFTER_REFUSAL_MS = 120_000;

/**
 * Record that one of this box's meters refused THIS run, so a pause that
 * follows can say so. Silent unless the run is live — a settled record has
 * nothing left to pause.
 *
 * Called from the routes that hold the refusal (the media routes): by the
 * time `pauseRun` runs, the refusal is long gone and the pause route knows
 * only a run id.
 */
export function noteAllowanceRefusal(
  runId: string,
  meter: CodingPauseMeter,
  detail: { resetsAt: string | null; message: string },
): void {
  const state = live.get(runId);
  if (!state) return;
  state.allowanceRefusal = {
    meter,
    resetsAt: detail.resetsAt,
    message: detail.message.slice(0, MAX_PAUSE_MESSAGE_CHARS),
    at: Date.now(),
  };
}

/**
 * WHY this run is being asked to pause: an allowance the box was refused
 * moments ago, or — the default, and what every ordinary pause gets — the
 * owner.
 *
 * The refusal is CONSUMED whether or not it qualifies, so it can explain at
 * most the one pause that directly followed it. Everything else about the
 * attribution is deliberately narrow: only a media route can record a
 * refusal, only for the run it refused, only while that run is live, and only
 * for as long as PAUSE_AFTER_REFUSAL_MS. Anything outside that is
 * `{ kind: "owner" }`, because an unexplained pause has to read as the
 * ordinary one rather than borrow a reason.
 */
function takePauseReason(state: LiveRun): CodingPauseReason {
  const refusal = state.allowanceRefusal;
  state.allowanceRefusal = null;
  if (!refusal || Date.now() - refusal.at > PAUSE_AFTER_REFUSAL_MS) return { kind: "owner" };
  return { kind: "allowance", meter: refusal.meter, resetsAt: refusal.resetsAt, message: refusal.message };
}

/** What a media route needs to know before it spends anything. Null when no run is live. */
export function activeRunMedia(): { id: string; directory: string; media: RunMedia; generated: { images: number; audio: number } } | null {
  const run = activeRun();
  if (!run) return null;
  return { id: run.id, directory: run.directory, media: run.media, generated: { ...run.mediaGenerated } };
}

/**
 * A path in the run's own evidence folder. relativeToRun leaves it absolute,
 * because that folder is never inside a working folder — resolveWorkingDirectory
 * keeps every run out of data/ except the code projects.
 */
function isEvidencePath(run: CodingRun, file: string): boolean {
  return path.isAbsolute(file) && isInside(file, artifactsDir(run.id));
}

/**
 * Commands that inspect the project without changing it.
 *
 * `commandsRun === 0` was too blunt for the retry gate: the real authentication
 * failure can arrive after Claude Code has only run `ls -la`, leaving no state
 * that makes a fresh attempt unsafe. Keep this deliberately narrower than the
 * Bash allow-list. Shell composition/redirection and commands such as npm,
 * Python, git commit, mkdir or cp remain side-effecting because proving their
 * behaviour from a command string is not possible.
 */
export function isReadOnlyInspectionCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`\n\r]|\$\(/.test(trimmed)) return false;
  return /^(?:pwd|ls|cat|head|tail|wc|grep)(?:\s|$)/.test(trimmed)
    || /^git\s+(?:status|diff|log)(?:\s|$)/.test(trimmed);
}

/**
 * Setup commands a retry may safely repeat.
 *
 * Seen on a real box: a run died to a transient proxy failure seconds after
 * `npm install three esbuild ws`, and the side-effect guard turned that one
 * upstream blink into a dead run. A package install converges — a fresh
 * attempt re-runs it into the same node_modules and lockfile — so its
 * leftovers cannot mislead a second attempt the way a half-finished edit
 * can. Deliberately narrow, and per manager: yarn, pnpm and bun run the
 * package.json SCRIPT of that name for a subcommand they do not recognise
 * (verified on this box: bun 1.4.0 executed `"scripts": {"ping": ...}` for
 * `bun ping`), so each manager is granted only its own builtins. `npm run`,
 * `npx`, `uninstall` and everything else stay side-effecting, because
 * convergence cannot be proven from those strings.
 */
export function isRetrySafeSetupCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`\n\r]|\$\(/.test(trimmed)) return false;
  return /^npm\s+(?:install|ci|add|ping)(?:\s|$)/.test(trimmed)
    || /^bun\s+(?:install|ci|add)(?:\s|$)/.test(trimmed)
    || /^(?:pnpm|yarn)\s+(?:install|add)(?:\s|$)/.test(trimmed)
    || /^(?:node|npm|pnpm|yarn|bun)\s+(?:--version|-v)\s*$/.test(trimmed);
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  /** system/thinking_tokens: reasoning tokens so far IN THE CURRENT BLOCK —
   *  the count starts over with each new reasoning block, so a run's total
   *  is the sum of the blocks, never the largest figure seen. */
  estimated_tokens?: number;
  /** `user` events carry tool_result blocks; that is how a sub-agent reports back. */
  session_id?: string;
  /** Set on events a SUB-AGENT produced; the main loop's events carry none. */
  parent_tool_use_id?: string;
  /** system/task_started, task_progress, task_notification: the tool_use the
   *  background task answers, and (on the notification) what it spent. */
  tool_use_id?: string;
  task_type?: string;
  usage?: unknown;
  model?: string;
  /** `id` is the API message: the CLI emits one assistant event PER CONTENT
   *  BLOCK of it (thinking, then text or tool_use), each with the same usage. */
  message?: { id?: unknown; content?: unknown; usage?: unknown; model?: unknown };
  /** assistant: the CLI's own tag on a message it wrote instead of an API answer (`rate_limit`, `billing_error`, …). */
  error?: unknown;
  /** system/task_started: what the helper was asked, in the CLI's words. */
  description?: unknown;
  result?: unknown;
  is_error?: boolean;
  num_turns?: number;
  permission_denials?: unknown;
  /** result event: per-model token breakdown, keyed by model name. */
  modelUsage?: unknown;
  errors?: unknown;
}

/** How many refused actions a run keeps. Enough to see the pattern. */
const MAX_DENIALS_KEPT = 5;
const MAX_DENIAL_CHARS = 160;
/** The bound on a refused action's whole text (`CodingDenial.fullText`); mirrored by DENIAL_FULL_TEXT_CUT in coding-team-board.ts. */
const MAX_DENIAL_FULL_CHARS = 2000;

/**
 * One refused action, as the owner should read it. Claude Code sends
 * `{ tool_name, tool_use_id, tool_input }`; the useful part is the tool and
 * the one field that says what it was pointed at.
 */
function denialParts(entry: unknown): { tool: string; target: string | null } {
  if (!entry || typeof entry !== "object") return { tool: "tool", target: null };
  const e = entry as { tool_name?: unknown; tool_input?: unknown };
  const tool = typeof e.tool_name === "string" && e.tool_name ? e.tool_name : "tool";
  const input = (e.tool_input && typeof e.tool_input === "object" ? e.tool_input : {}) as Record<string, unknown>;
  // `url` joined the list so a refused WebFetch says WHICH address it was
  // refused rather than "(no details)". It gets no "Allow next time" — only the
  // file tools may be named in an owner rule (ALLOW_RULE_TOOLS) — but the
  // sentence the owner reads is the poorer for leaving it out.
  const target = ["command", "file_path", "notebook_path", "path", "url", "pattern"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v !== "");
  return { tool, target: target ?? null };
}

/** A refused action's whole description, uncut. */
function wholeDenial(entry: unknown): string {
  const { tool, target } = denialParts(entry);
  return `${tool}: ${target ?? "(no details)"}`;
}

function describeDenial(entry: unknown): string {
  return wholeDenial(entry).slice(0, MAX_DENIAL_CHARS);
}

/**
 * What this box would have to allow for a refused action to go through — the
 * narrowest such rule, already judged against the floor.
 *
 * Two halves, and only the first of them is portable: `deriveAllowRule` turns
 * "Read of /…/memory/notes.md" into `Read(//…/memory/**)` with no knowledge of
 * this device at all, and the validator then holds that text against what the
 * box actually refuses (`allowRuleContext()`, walked from disk). Deny outranks
 * allow in Claude Code, so a rule inside a denied tree would grant nothing:
 * those come back as a `refusal` code rather than a rule, and the page says why
 * instead of offering a button that could not work.
 *
 * `{ rule: null, refusal: null }` is the third answer and the commonest: a Bash
 * command, a tool no rule may name, a refusal whose target could not be read.
 * Nothing to offer, and nothing to explain either.
 *
 * @param denial the refused action's tool and what it was pointed at
 * @param context what the device denies right now; read here when omitted
 */
export function suggestAllowRule(
  denial: DenialInput,
  context?: AllowRuleContext,
): { rule: string | null; refusal: AllowRuleRefusal | null } {
  const candidate = deriveAllowRule(denial);
  if (!candidate) return { rule: null, refusal: null };
  // No `known` list: this is the rule the action NEEDS, and whether the owner
  // already saved it is the add route's question, not this one's.
  const verdict = validateAllowRule(candidate, [], context ?? allowRuleContext());
  return verdict.ok ? { rule: verdict.rule, refusal: null } : { rule: null, refusal: verdict.code };
}

/**
 * The refusals of one result event, as the owner reads them AND as this box can
 * answer them.
 *
 * The context is read at most ONCE per event — `fileDenyRules()` walks two
 * directories — and only when there is a candidate rule to judge against it,
 * which is why the cheap pure derivation is asked first.
 */
function denialsFrom(entries: readonly unknown[]): CodingDenial[] {
  let context: AllowRuleContext | null = null;
  return entries.map((entry) => {
    const parts = denialParts(entry);
    const whole = wholeDenial(entry);
    const text = whole.slice(0, MAX_DENIAL_CHARS);
    // Kept only when the display cut left some of it out.
    const full = whole.length > text.length ? { fullText: whole.slice(0, MAX_DENIAL_FULL_CHARS) } : {};
    if (!deriveAllowRule(parts)) return { text, rule: null, refusal: null, ...full };
    context ??= allowRuleContext();
    const { rule, refusal } = suggestAllowRule(parts, context);
    return { text, rule, refusal, ...full };
  });
}

/** Exported for the test: this parses a payload the device does not control. */
export const describeDenialForTests = describeDenial;

/** Exported for the same reason — and because the rule half is what decides
 *  whether a refusal gets an "Allow next time" button at all. */
export const denialsFromForTests = denialsFrom;

/**
 * The `todos` a TodoWrite tool_use carries, or null when the payload is not a
 * list at all — the caller then leaves the plan it has alone rather than
 * replacing a good plan with nothing. A list with a broken item in it keeps
 * the items that read; the tool's shape is Claude Code's to change, and the
 * card must never crash on a field the model spelled differently.
 */
function parseTodos(raw: unknown): CodingTodo[] | null {
  if (!Array.isArray(raw)) return null;
  const cut = (s: string) => {
    const cleaned = s.replace(/\s+/g, " ").trim();
    return cleaned.length > MAX_TODO_CHARS ? `${cleaned.slice(0, MAX_TODO_CHARS - 1)}…` : cleaned;
  };
  const todos: CodingTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== "string") continue;
    const content = cut(t.content);
    if (!content) continue;
    // An unknown status is "not done": the safe reading of a word we do not know.
    const status = (TODO_STATUSES as readonly unknown[]).includes(t.status) ? t.status as CodingTodoStatus : "pending";
    const activeForm = typeof t.activeForm === "string" ? cut(t.activeForm) : "";
    todos.push(activeForm ? { content, status, activeForm } : { content, status });
    if (todos.length >= MAX_TODOS) break;
  }
  return todos;
}

/** Exported for the test, for the same reason. */
export const parseTodosForTests = parseTodos;

/**
 * Add to the run's bill and stop it at the owner's ceiling. The CLI has no
 * flag for a token limit, so the device enforces it from the usage the stream
 * reports. Marked resumable: the work is real, it simply ran out of room —
 * the same shape as a step ceiling.
 */
/**
 * The breakdown raised to the CLI's own per-category bill for this process
 * (modelUsage: every model, sub-agents and workflow agents included, counted
 * from zero per process), never lowered — the live sum from the assistant
 * events misses what a workflow's agents read from cache.
 */
function raiseTokenBreakdown(run: CodingRun, base: TokenBreakdown, modelUsage: Record<string, unknown>): void {
  const proc = emptyTokenBreakdown();
  for (const m of Object.values(modelUsage)) {
    if (!m || typeof m !== "object") continue;
    const u = m as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k] as number) ? (u[k] as number) : 0);
    proc.input += n("inputTokens");
    proc.output += n("outputTokens");
    proc.cacheCreation += n("cacheCreationInputTokens");
    proc.cacheRead += n("cacheReadInputTokens");
  }
  const b = run.tokenBreakdown;
  b.input = Math.max(b.input, base.input + proc.input);
  b.output = Math.max(b.output, base.output + proc.output);
  b.cacheCreation = Math.max(b.cacheCreation, base.cacheCreation + proc.cacheCreation);
  b.cacheRead = Math.max(b.cacheRead, base.cacheRead + proc.cacheRead);
}

function noteTokens(run: CodingRun, state: LiveRun, tokens: number): boolean {
  if (!(tokens > 0)) return false;
  run.tokensUsed += tokens;
  if (run.tokenLimit !== null && run.tokensUsed >= run.tokenLimit && state.endRequested === null) {
    state.endRequested = "stop";
    run.resumable = true;
    run.error = `Stopped at the token limit (${run.tokensUsed.toLocaleString("en-US")} of ${run.tokenLimit.toLocaleString("en-US")}). Raise the limit or resume with a narrower task.`;
    pushProgress(run, RUNNER_STEP.tokenLimit);
    console.error(`[coding-agent] ${run.id} hit its token limit at ${run.tokensUsed}`);
    endProcess(state);
    return true;
  }
  return false;
}

/**
 * A workflow's agents never appear on the stream; the CLI reports the
 * workflow's cumulative spend on every task_progress and once more on its
 * task_notification. Bill the delta each time, so the owner's ceiling holds
 * WHILE a fan-out runs rather than after it, and a workflow the run was
 * stopped under has still been billed for what it did.
 */
function billWorkflowProgress(run: CodingRun, state: LiveRun, id: string, usage: unknown): boolean {
  const helper = state.openSubagents.get(id);
  if (!helper || helper.type !== WORKFLOW_SUBAGENT_TYPE) return false;
  const total = usage && typeof usage === "object" ? (usage as { total_tokens?: unknown }).total_tokens : undefined;
  if (typeof total !== "number") return false;
  const billed = state.helperBilled.get(id) ?? 0;
  if (total <= billed) return false;
  state.helperBilled.set(id, total);
  return noteTokens(run, state, total - billed);
}

/** The text of a tool_result, whether the CLI sent a string or text blocks. */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

/**
 * The installed Claude Code (2.1.259, measured 2026-09-03) launches
 * sub-agents and workflows in the BACKGROUND: the
 * tool_result that answers the Agent or Workflow call is only the launch
 * receipt ("Async agent launched successfully…", "Workflow launched in
 * background…") and the helper is still out. Its `task_notification` is what
 * closes it. Measured on this box, 2026-09-03: read as a completion, the
 * receipt made every helper "finished" the moment it started, so the card
 * never showed one working.
 */
function isBackgroundLaunchReceipt(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return false;
  return /^\s*(Async agent launched|Workflow launched in background)/.test(toolResultText(block));
}

/** The sub-agent's "kind" a Workflow call gets: one helper of type "workflow". */
const WORKFLOW_SUBAGENT_TYPE = "workflow";
/** Message ids remembered for billing — a few turns of interleaved helpers. */
const BILLED_IDS_KEPT = 64;

function openSubagent(run: CodingRun, state: LiveRun, id: unknown, kind: string, what: string): void {
  if (typeof id === "string" && id) {
    state.openSubagents.set(id, { type: kind, description: what.slice(0, 120), startedAt: Date.now() });
  }
  run.subagentsTotal += 1;
  run.subagentsByType[kind] = (run.subagentsByType[kind] ?? 0) + 1;
  run.subagentsActive = state.openSubagents.size;
  run.activeSubagents = [...state.openSubagents.values()];
}

/**
 * Closes the helper `id` names, if it is still out. Answers which it was.
 * A REFUSED launch (an is_error tool_result — the CLI's "Review dynamic
 * workflow before running", or a sub-agent type it does not know) is taken
 * back out of the counts: a helper that never ran is not one that finished.
 */
function closeSubagent(run: CodingRun, state: LiveRun, id: string, refused = false): ActiveSubagent | null {
  const done = state.openSubagents.get(id);
  if (!done || !state.openSubagents.delete(id)) return null;
  state.helperBilled.delete(id);
  run.subagentsActive = state.openSubagents.size;
  run.activeSubagents = [...state.openSubagents.values()];
  // The record of it: what it did and how long it took, for the run's page.
  run.subagents = [...run.subagents.slice(-(SUBAGENT_HISTORY_KEPT - 1)), { ...done, endedAt: Date.now(), refused }];
  const isWorkflow = done.type === WORKFLOW_SUBAGENT_TYPE;
  if (refused) {
    run.subagentsTotal = Math.max(0, run.subagentsTotal - 1);
    const left = (run.subagentsByType[done.type] ?? 1) - 1;
    if (left > 0) run.subagentsByType[done.type] = left;
    else delete run.subagentsByType[done.type];
    pushProgress(run, RUNNER_STEP.helperSettled({ workflow: isWorkflow, type: done.type, refused: true }));
  } else {
    pushProgress(run, RUNNER_STEP.helperSettled({ workflow: isWorkflow, type: done.type, refused: false }));
  }
  return done;
}

/** How many top-level entries the task's folder line names before it gives a count instead. */
const FOLDER_LISTING_MAX = 30;

/**
 * One line about what the working folder holds, sent with the task: a
 * fresh run otherwise spends its first step on a Glob for a file the task
 * named (bench s-01, 2026-09-05: 2.7 s and a 15k-token cache read to learn
 * that a two-file folder contains config.js). Top level only, `.git` left
 * out, folders marked with a slash; a folder past the cap gets its count,
 * and a folder that cannot be read is simply not described.
 */
export function folderListing(directory: string): string {
  const names = folderEntries(directory);
  if (names === null) return "the working folder could not be listed.";
  if (names.length === 0) return "this folder is empty.";
  if (names.length > FOLDER_LISTING_MAX) return `this folder has ${names.length} top-level entries.`;
  return `this folder contains: ${names.join(", ")}`;
}

/**
 * The working folder's top-level entries as `folderListing` names them —
 * `.git` left out, folders with a trailing slash, sorted — or null when the
 * folder cannot be read. Shared with the token diet's visual decision
 * (`decideRunVisual`), so the run is judged on the folder it is told about.
 */
export function folderEntries(directory: string): string[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).filter((e) => e.name !== ".git");
  } catch {
    return null;
  }
  // Each name printable and short: a name is data the run would see in its
  // first `ls` regardless, but a newline or a control character in one
  // would break the ONE line this is, and a very long one is not a name.
  return entries
    .map((e) => `${e.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80)}${e.isDirectory() ? "/" : ""}`)
    .filter((n) => n !== "/" && n !== "")
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The token diet's visual decision for a run (CodingRun.visual): always yes
 * under `visualTools: "always"`; under "auto", `looksVisual` over the task and
 * the working folder's top-level entries — plus `src/components` when `src/`
 * holds one, the one nested folder the rule names.
 */
export function decideRunVisual(diet: CodingDiet, task: string, directory: string): boolean {
  if (diet.visualTools === "always") return true;
  const entries = folderEntries(directory) ?? [];
  if (entries.includes("src/")) {
    try {
      if (fs.statSync(path.join(directory, "src", "components")).isDirectory()) entries.push("src/components/");
    } catch {
      // no src/components — nothing to add
    }
  }
  return looksVisual(task, entries);
}

/**
 * The one sentence a run is told about the files it was GIVEN.
 *
 * Read off DISK rather than off the record, so a file the owner dropped into
 * the folder between the start and the spawn — or between two attempts at a
 * deliverable, which respawn from the same record — is named too. The record's
 * `refused` list is still where the refusals come from: they are a fact about
 * the hand-over, not about what is in the folder now.
 *
 * Always says something. "Nothing was given" is the line that stops a run
 * searching the disk for a picture the assistant only meant to generate, and
 * naming the media folder as unreachable is what stops it trying `cp`.
 */
export function runInputsNote(run: Pick<CodingRun, "id" | "inputs">): string {
  let files: RunInputFile[] = [];
  try {
    files = listRunInputs(run.id);
  } catch {
    files = run.inputs?.files ?? [];
  }
  const refused = run.inputs?.refused ?? [];
  // SHORT on purpose. The standing facts — that the folder is readable, that
  // the assistant's media tree is not — are in the brief, which every run gets;
  // repeating them here would put four sentences of boilerplate in front of
  // every task for the sake of the rare run that has inputs at all.
  const parts: string[] = [files.length > 0
    ? `given files, in ${runInputsDir(run.id)}: ${files.map((f) => f.name).join(", ")}`
    : `no files were given to this run (${runInputsDir(run.id)} is where any would be)`];
  if (refused.length > 0) {
    parts.push(`the device could not hand over ${refused.map((r) => `${r.name} (${r.code})`).join(", ")}, so do not look for them elsewhere`);
  }
  return `${parts.join("; ")}.`;
}

/** One line of `--output-format stream-json`. */
/** The first text block of an assistant event, bounded. */
function firstEventText(event: StreamEvent): string | null {
  const raw = event.message?.content;
  if (!Array.isArray(raw)) return null;
  for (const block of raw as Record<string, unknown>[]) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim().slice(0, 400);
  }
  return null;
}

/** See the call site in handleEvent. */
function noteAnthropicLimitSignal(state: LiveRun, event: StreamEvent): void {
  const tagged = event.error === "rate_limit" || event.error === "billing_error";
  const authTagged = event.error === "authentication_failed";
  const synthetic = event.message?.model === "<synthetic>";
  if (!tagged && !authTagged && !synthetic) return;
  const text = firstEventText(event);
  if (!text) return;
  // A synthetic message is not always a limit (an interrupted request is one
  // too), so an untagged one must read as a limit in its own words; a tagged
  // one IS the CLI saying so, whatever its wording.
  if (tagged || detectAnthropicLimit(text, Date.now())) state.limitSignal = text;
  // The same for a refused credential (TASK-1260): "Invalid API key · Please
  // run /login", "OAuth token revoked", a 401.
  else if (authTagged || detectAnthropicAuthFailure(text)) state.authSignal = text;
}

function handleEvent(run: CodingRun, state: LiveRun, event: StreamEvent): void {
  if (typeof event.session_id === "string" && event.session_id && !run.sessionId) run.sessionId = event.session_id;

  // ANY event is a sign of life, whatever it is.
  run.lastActivityAt = Date.now();

  // Claude Code reports reasoning progress before it has anything to say. It
  // is the only signal that separates "thinking hard" from "hung", and a run
  // on `effort: max` can sit here for minutes on the first turn.
  if (event.type === "system" && event.subtype === "thinking_tokens") {
    // `estimated_tokens` counts the CURRENT reasoning block: it climbs while
    // the block runs and starts again from a small number with the next one.
    // Cycle 1 of the bench (2026-09-05) kept the largest figure, i.e. one
    // block's peak; the record now adds every block up. A figure below the
    // last one seen is a new block, and all of it is new.
    const total = typeof event.estimated_tokens === "number" && event.estimated_tokens > 0 ? event.estimated_tokens : 0;
    run.thinkingTokens += total >= state.thinkingSeen ? total - state.thinkingSeen : total;
    state.thinkingSeen = total;
    // One line, not one per event: these arrive continuously and would drown
    // the progress feed. The live count is on the record for anyone watching.
    if (!state.sawThinking) {
      state.sawThinking = true;
      pushProgress(run, RUNNER_STEP.thinking);
    }
    return;
  }

  if (event.type === "system" && event.subtype === "init") {
    if (typeof event.model === "string" && event.model) run.model = event.model;
    // A -p run with a helper out is started AGAIN by the CLI when that
    // helper reports: a second init, and a second result when the model had
    // ended its turn (measured on 2.1.259) — or no result yet when it had
    // not (run-roo5mgvd: the notification and the init landed mid-turn).
    // Same session, same process: any init after the first is a
    // continuation, not a fresh start.
    pushProgress(run, state.sawInit ? RUNNER_STEP.continuing : RUNNER_STEP.started(run.model));
    // The harness is talking to us from inside its scope, which is the only real
    // proof that scopes work on this box — enough to retire a refusal the box
    // learned earlier and has been reporting ever since.
    if (!state.sawInit && state.unit) noteScopeWorked();
    // And the same proof for streaming input: the harness accepted the flag
    // and is talking, so a refusal this box learned earlier is history.
    if (!state.sawInit && state.streamInput) noteStreamInputWorked();
    state.sawInit = true;
    return;
  }

  // The CLI's own words for a helper it just launched — for a workflow, the
  // description the parser could only guess at from the script.
  if (event.type === "system" && event.subtype === "task_started") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    const helper = id ? state.openSubagents.get(id) : undefined;
    if (helper && typeof event.description === "string" && event.description.trim()) {
      helper.description = event.description.trim().slice(0, 120);
      run.activeSubagents = [...state.openSubagents.values()];
    }
    return;
  }

  if (event.type === "system" && event.subtype === "task_progress") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (id) billWorkflowProgress(run, state, id, event.usage);
    return;
  }

  // A background helper came back (see isBackgroundLaunchReceipt). A
  // sub-agent's own turns were on this stream and billed as they came; a
  // workflow's were not — its notification carries the final total.
  if (event.type === "system" && event.subtype === "task_notification") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!id) return;
    billWorkflowProgress(run, state, id, event.usage);
    closeSubagent(run, state, id);
    return;
  }

  if (event.type === "assistant") {
    // A model answered — unless the CLI wrote this message itself to carry an
    // API error, which is exactly the shape of a harness that never got one to
    // answer. First, ahead of the billing below and its early return.
    if (event.message?.model !== "<synthetic>" && !event.error) state.sawModelAnswer = true;
    // Every request pays for the input it carries, so input is summed per turn
    // even though the conversation repeats — that is what a bill counts. Per
    // MESSAGE, not per event: see LiveRun.lastBilledMessageId.
    const usage = event.message?.usage;
    const messageId = typeof event.message?.id === "string" && event.message.id ? event.message.id : null;
    if (usage && typeof usage === "object" && (messageId === null || !state.billedMessageIds.has(messageId))) {
      if (messageId !== null) {
        state.billedMessageIds.add(messageId);
        if (state.billedMessageIds.size > BILLED_IDS_KEPT) {
          const oldest = state.billedMessageIds.values().next().value;
          if (oldest !== undefined) state.billedMessageIds.delete(oldest);
        }
      }
      const u = usage as Record<string, unknown>;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      state.outputBilledInSegment += n("output_tokens");
      run.tokenBreakdown.input += n("input_tokens");
      run.tokenBreakdown.output += n("output_tokens");
      run.tokenBreakdown.cacheCreation += n("cache_creation_input_tokens");
      run.tokenBreakdown.cacheRead += n("cache_read_input_tokens");
      const stoppedNow = noteTokens(run, state, n("input_tokens") + n("output_tokens")
        + n("cache_creation_input_tokens") + n("cache_read_input_tokens"));
      if (stoppedNow) return;
    }
    // A helper's own turns (parent_tool_use_id set) are billed above and
    // nothing more: its words are not the run's words, its Bash is not the
    // run's command, and a tester's `npm test` must not mark the run as one
    // with side effects. The card already names the helper that is out.
    if (typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id) return;
    // An Anthropic account at its cap. The CLI does not answer that with an
    // API message: it writes a SYNTHETIC one (model "<synthetic>", tagged
    // `error: "rate_limit"` on the builds that tag it) carrying its own line —
    // "You've hit your session limit · resets 10:50pm". Remembered as the
    // HARNESS's words, so the settle path never has to take the run's own
    // closing sentence for a limit (TASK-902).
    if (run.provider === "anthropic") noteAnthropicLimitSignal(state, event);
    // numTurns stays the CLI's own number from the final result event.
    // A live per-event count was tried and measured 291 events against the
    // CLI's 38 turns on run-5vt51ppv — no event arithmetic reproduces the
    // CLI's definition, and a number that snaps from 272 to 38 at the finish
    // is worse than none. Progress bars use the run's TodoWrite plan instead.
    const raw = event.message?.content;
    const content = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        pushProgress(run, block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
        // A run in a worktree pointing a file tool at the project's own path:
        // kept until its result says whether it was refused (below).
        const counterpart = typeof block.id === "string" && block.id ? worktreeHintFor(run.directory, block.name, input) : null;
        if (counterpart) state.worktreeTargets.set(block.id as string, { tool: block.name, counterpart });
        switch (block.name) {
          case "Bash":
            run.commandsRun += 1;
            if (!isReadOnlyInspectionCommand(input.command) && !isRetrySafeSetupCommand(input.command)) state.commandMayHaveSideEffects = true;
            pushProgress(run, `$ ${typeof input.command === "string" ? input.command : ""}`);
            break;
          case "Write":
          case "Edit":
          case "NotebookEdit": {
            const file = relativeToRun(run, input.file_path ?? input.notebook_path);
            // Asked for, not yet done — confirmed when its tool_result lands.
            state.sawWriteAttempt = true;
            // A write into the run's own evidence folder — report.md, a test
            // log, the brief asks for both — is not project work: the folder
            // is listed with the run already, and counting it here made a
            // review pass that changed nothing say "1 file changed" and armed
            // a review pass of no work. It still shows in the feed below.
            if (file && !isEvidencePath(run, file) && typeof block.id === "string" && block.id) {
              state.pendingFiles.set(block.id, file);
            }
            pushProgress(run, `${block.name} ${file ?? ""}`);
            break;
          }
          case "Task":
          case SUBAGENT_TOOL: {
            // A sub-agent is out. Its id is what tells us when it comes back.
            const what = typeof input.description === "string" ? input.description : "";
            const kind = typeof input.subagent_type === "string" ? input.subagent_type : "";
            openSubagent(run, state, block.id, kind || "sub-agent", what);
            pushProgress(run, RUNNER_STEP.helperStarted({ workflow: false, type: kind, what }));
            break;
          }
          case WORKFLOW_TOOL: {
            // A dynamic workflow: ONE helper of type "workflow" on the
            // record, by choice — its agents are not on this stream (their
            // spend arrives as task_progress totals, the models they used in
            // the final modelUsage), and a fan-out is one decision of the
            // run's, not twelve. Named after its script's own meta until
            // task_started brings the CLI's own description.
            const script = typeof input.script === "string" ? input.script : "";
            const what = /description\s*:\s*(['"`])((?:(?!\1).)*)\1/.exec(script)?.[2] ?? "";
            openSubagent(run, state, block.id, WORKFLOW_SUBAGENT_TYPE, what);
            pushProgress(run, RUNNER_STEP.helperStarted({ workflow: true, type: WORKFLOW_SUBAGENT_TYPE, what }));
            break;
          }
          case "Read":
            pushProgress(run, `Read ${relativeToRun(run, input.file_path) ?? ""}`);
            break;
          case "Glob":
          case "Grep":
            pushProgress(run, `${block.name} ${typeof input.pattern === "string" ? input.pattern : ""}`);
            break;
          case "TodoWrite": {
            // The run's plan, whole: TodoWrite always sends the full list, so
            // the newest one replaces the record's. One summary line in the
            // feed — the list itself lives on the record, where the card
            // draws it as a checklist rather than as twenty progress lines.
            const todos = parseTodos(input.todos);
            if (!todos) {
              pushProgress(run, block.name);
              break;
            }
            run.todos = todos;
            const done = todos.filter((t) => t.status === "completed").length;
            pushProgress(run, `Plan: ${todos.length} tasks, ${done} done`);
            break;
          }
          default:
            pushProgress(run, `${block.name}`);
        }
      }
    }
    return;
  }

  // A tool_result closes whatever it answers. Only sub-agent ids are tracked,
  // so every other tool_result falls through harmlessly.
  if (event.type === "user") {
    const raw = event.message?.content;
    const content = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      // A launch receipt is not a result: the helper stays out until its
      // task_notification (see isBackgroundLaunchReceipt). Anything else
      // closes it — a synchronous answer as finished, a refusal as refused.
      if (state.openSubagents.has(block.tool_use_id) && !isBackgroundLaunchReceipt(block as Record<string, unknown>)) {
        closeSubagent(run, state, block.tool_use_id, block.is_error === true);
      }
      const pending = state.pendingFiles.get(block.tool_use_id);
      if (pending !== undefined) {
        state.pendingFiles.delete(block.tool_use_id);
        // A refusal comes back as an error result; only a clean one counts.
        if (block.is_error !== true) noteFile(run, pending);
      }
      // Refused on the project's path from inside a worktree: the retry
      // hint goes to the run now, while it can still act on it.
      const aimed = state.worktreeTargets.get(block.tool_use_id);
      if (aimed) {
        state.worktreeTargets.delete(block.tool_use_id);
        if (block.is_error === true) hintWorktree(run, state, aimed.tool, aimed.counterpart);
      }
    }
    return;
  }

  if (event.type === "result") {
    // A result per CLI segment: the first for the model's own turn, one more
    // each time it was restarted by a background helper (see the init
    // handler). num_turns and permission_denials are PER SEGMENT — the
    // second result of the probe said 1 turn and no denials — so they add
    // up; modelUsage and the summary are cumulative, and the last one wins.
    const continuation = state.sawResult;
    state.sawResult = true;
    if (typeof event.num_turns === "number") run.numTurns = continuation ? run.numTurns + event.num_turns : event.num_turns;
    // The segment's output, less what its assistant events already billed.
    if (event.usage && typeof event.usage === "object") {
      const out = (event.usage as { output_tokens?: unknown }).output_tokens;
      if (typeof out === "number" && out > state.outputBilledInSegment) {
        run.tokenBreakdown.output += out - state.outputBilledInSegment;
        noteTokens(run, state, out - state.outputBilledInSegment);
      }
    }
    state.outputBilledInSegment = 0;
    // Which models actually did work — the main run and every sub-agent.
    if (event.modelUsage && typeof event.modelUsage === "object") {
      const usage = event.modelUsage as Record<string, unknown>;
      run.modelsUsed = Object.keys(usage).sort();
      // The CLI's own bill for everything the process ran — main loop,
      // sub-agents AND workflow agents, cache reads included — cumulative
      // across segments. The live sum above under-counts a workflow (its
      // task_progress totals leave out cache reads: measured 118k reported
      // against 540k in the agents' transcripts on run-roo5mgvd), so the
      // record is raised to the CLI's number here, never lowered.
      const total = Object.values(usage).reduce<number>((sum, m) => {
        if (!m || typeof m !== "object") return sum;
        const u = m as Record<string, unknown>;
        const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
        return sum + n("inputTokens") + n("outputTokens") + n("cacheReadInputTokens") + n("cacheCreationInputTokens");
      }, 0);
      // A result with helpers still out is a SEGMENT: the process runs on
      // and another segment follows, so the ceiling stays armed through it.
      // The last result — nothing out — is reconciliation only: the run has
      // reported its outcome, and crossing the ceiling here must not turn a
      // finished run into a device stop (noteTokens would, and finishRun
      // would then discard the outcome and settle it as stopped, resumable).
      // Not for a resumed session: its modelUsage carries the session's
      // history too (see LiveRun.resumedSession).
      if (!state.resumedSession) {
        if (total > run.tokensUsed) {
          if (state.openSubagents.size > 0) noteTokens(run, state, total - run.tokensUsed);
          else run.tokensUsed = total;
        }
        raiseTokenBreakdown(run, state.breakdownAtSpawn, usage);
      }
    }
    if (Array.isArray(event.permission_denials)) {
      const parsed = denialsFrom(event.permission_denials);
      // The refusals a run in a worktree met on the project's own path, each
      // marked with where it was pointed instead — and hinted if its
      // tool_result slipped by: queued, for afterTurn below to deliver as the
      // next turn. Counted whole, not in the kept few: a team reads every one
      // of them as a note, never as a rejection.
      let hinted = 0;
      event.permission_denials.forEach((entry, i) => {
        const e = (entry && typeof entry === "object" ? entry : {}) as { tool_name?: unknown; tool_input?: unknown };
        const counterpart = worktreeHintFor(run.directory, e.tool_name, e.tool_input);
        if (!counterpart) return;
        hinted += 1;
        parsed[i].worktreePath = counterpart;
        hintWorktree(run, state, e.tool_name as string, counterpart, false);
      });
      run.worktreeHints = (continuation ? run.worktreeHints : 0) + hinted;
      const described = parsed.map((d) => d.text);
      run.permissionDenials = (continuation ? run.permissionDenials : 0) + event.permission_denials.length;
      run.deniedActions = (continuation ? [...run.deniedActions, ...described] : described).slice(0, MAX_DENIALS_KEPT);
      // The same cut, kept apart rather than paired by index: a reader renders
      // one list or the other, never one indexed into the other.
      run.denials = (continuation ? [...run.denials, ...parsed] : parsed).slice(0, MAX_DENIALS_KEPT);
    }
    // Scrubbed before it is cut, for the reason pushProgress is: the summary is
    // persisted, rendered, filed as report.md and read back by the agent's own
    // status tool, and a run's closing words are where it explains what it did
    // with the token it was given.
    const text = typeof event.result === "string" ? redactForRun(run.id, event.result).trim() : "";
    if (text) {
      run.summary = text.slice(0, MAX_SUMMARY_CHARS);
      run.resultText = text;
    }
    switch (event.subtype) {
      case "success":
        state.outcome = {
          status: event.is_error ? "failed" : "completed",
          error: event.is_error && !run.error ? (text || "Claude Code reported an error.").slice(0, MAX_ERROR_CHARS) : null,
          resumable: false,
        };
        break;
      // The two ceilings are the ONLY failures a resume can help with: the
      // session did real work and simply ran out of room.
      case "error_max_turns":
        state.outcome = {
          status: "failed",
          resumable: true,
          error: `Stopped after ${run.numTurns || run.maxTurns} steps without finishing. Resume it with a narrower task, raise the step limit, or split the work.`,
        };
        break;
      case "error_max_budget_usd":
        state.outcome = {
          status: "failed",
          resumable: true,
          error: "Stopped at the cost ceiling for one run. Resume it with a narrower task, or split the work.",
        };
        break;
      default: {
        const errors = Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === "string").join("; ") : "";
        state.outcome = {
          status: "failed",
          resumable: false,
          error: (errors || text || "Claude Code stopped with an error.").slice(0, MAX_ERROR_CHARS),
        };
      }
    }
    // The CLI has finished a turn. Under streaming input it is now waiting on
    // stdin: hand it whatever the owner has queued, or close the pipe so it
    // can exit and the run can settle.
    afterTurn(run, state);
  }
}

/** A stored Codex thread usage, or null when the record carries none that reads. */
function readCodexThreadUsage(raw: unknown): { codexThreadUsage: CodexThreadUsage } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const input = n(u.input);
  const cachedInput = n(u.cachedInput);
  const output = n(u.output);
  if (input === null || cachedInput === null || output === null) return null;
  return { codexThreadUsage: { input, cachedInput, output } };
}

/**
 * What a Codex thread had already billed before this spawn: the largest usage
 * any record of the same thread carries — the run this one resumes, or this
 * very record's earlier spawn on a completion attempt. Codex reports a
 * thread's usage cumulatively, so a continuation's own share is its figure
 * less this one. Zero for a fresh thread.
 */
function codexUsageBaseline(sessionId: string | null): CodexThreadUsage {
  const base: CodexThreadUsage = { input: 0, cachedInput: 0, output: 0 };
  if (!sessionId) return base;
  for (const other of loadRuns()) {
    if (other.sessionId !== sessionId || !other.codexThreadUsage) continue;
    const u = other.codexThreadUsage;
    if (u.input + u.output > base.input + base.output) Object.assign(base, u);
  }
  return base;
}

/**
 * The usage of one Codex turn onto the record: this spawn's share of the
 * thread's cumulative figure (codexUsageBaseline), split the way the record
 * bills — fresh input, cached input read back, output. A figure BELOW the
 * baseline is not cumulative after all (a CLI that counts per process): it is
 * taken whole rather than read as a negative.
 *
 * @returns whether the token ceiling stopped the run (noteTokens)
 */
function applyCodexUsage(run: CodingRun, state: LiveRun, usage: CodexThreadUsage): boolean {
  const base = state.codexBaseline ?? { input: 0, cachedInput: 0, output: 0 };
  const cumulative = usage.input >= base.input && usage.output >= base.output && usage.cachedInput >= base.cachedInput;
  const input = cumulative ? usage.input - base.input : usage.input;
  const cached = Math.min(input, cumulative ? usage.cachedInput - base.cachedInput : usage.cachedInput);
  const output = cumulative ? usage.output - base.output : usage.output;
  run.codexThreadUsage = { ...usage };
  // The next turn of this same process (there is none in `codex exec` today)
  // would report a figure that includes this one.
  state.codexBaseline = { ...usage };
  run.tokenBreakdown.input += input - cached;
  run.tokenBreakdown.cacheRead += cached;
  run.tokenBreakdown.output += output;
  return noteTokens(run, state, input + output);
}

/**
 * One line of `codex exec --json`, onto the record — the Codex twin of
 * handleEvent, for an `openai` run. What the event MEANS is read by
 * codexEventActions (src/lib/coding-codex.ts, pure and tested on its own);
 * this applies it with the same helpers the Claude path uses, so the run's
 * feed, its changed files, its plan, its tokens and its verdict land in the
 * same fields the card, the settle and the commit read.
 */
function handleCodexEvent(run: CodingRun, state: LiveRun, event: unknown): void {
  run.lastActivityAt = Date.now();
  for (const action of codexEventActions(event)) {
    switch (action.kind) {
      case "session":
        if (!run.sessionId) run.sessionId = action.id;
        if (!state.sawInit) {
          // Codex does not name the model on the stream; the run asked for it
          // by name (`-m`), so the record says the model it asked for.
          run.model = run.requestedModel ?? defaultModelForProvider(run.provider);
          run.modelsUsed = run.model ? [run.model] : [];
          pushProgress(run, RUNNER_STEP.started(run.model));
          if (state.unit) noteScopeWorked();
          state.sawInit = true;
        }
        break;
      case "reasoning":
        state.sawModelAnswer = true;
        if (!state.sawThinking) {
          state.sawThinking = true;
          pushProgress(run, RUNNER_STEP.thinking);
        }
        break;
      case "message":
        state.sawModelAnswer = true;
        state.codexLastMessage = action.text;
        pushProgress(run, action.text);
        break;
      case "command":
        state.sawModelAnswer = true;
        run.commandsRun += 1;
        if (!isReadOnlyInspectionCommand(action.command) && !isRetrySafeSetupCommand(action.command)) state.commandMayHaveSideEffects = true;
        pushProgress(run, `$ ${action.command}`);
        break;
      case "files":
        state.sawModelAnswer = true;
        // Reported once the CLI has APPLIED the change — the confirmation a
        // Claude run's tool_result gives — so it counts at once.
        state.sawWriteAttempt = true;
        for (const raw of action.paths) {
          const file = relativeToRun(run, raw);
          if (file && !isEvidencePath(run, file)) noteFile(run, file);
          pushProgress(run, `Edit ${file ?? raw}`);
        }
        break;
      case "tool":
        state.sawModelAnswer = true;
        pushProgress(run, action.label);
        break;
      case "todos": {
        const todos = parseTodos(action.items.map((t) => ({ content: t.text, status: t.completed ? "completed" : "pending" })));
        if (!todos) break;
        run.todos = todos;
        const done = todos.filter((t) => t.status === "completed").length;
        pushProgress(run, `Plan: ${todos.length} tasks, ${done} done`);
        break;
      }
      case "usage":
        if (applyCodexUsage(run, state, { input: action.input, cachedInput: action.cachedInput, output: action.output })) return;
        break;
      case "completed": {
        state.sawResult = true;
        run.numTurns += 1;
        const text = state.codexLastMessage ? redactForRun(run.id, state.codexLastMessage).trim() : "";
        if (text) {
          run.summary = text.slice(0, MAX_SUMMARY_CHARS);
          run.resultText = text;
        }
        state.outcome = { status: "completed", error: null, resumable: false };
        break;
      }
      case "failed": {
        state.sawResult = true;
        const error = redactForRun(run.id, action.error).trim();
        if (isCodexLimit(error)) state.codexLimit = error;
        else if (isCodexAuthFailure(error)) state.codexAuth = error;
        state.outcome = { status: "failed", error: (error || "Codex stopped with an error.").slice(0, MAX_ERROR_CHARS), resumable: false };
        break;
      }
      case "notice":
        state.codexNotice = action.text;
        break;
    }
  }
}

/**
 * Failures worth ONE automatic retry.
 *
 * Observed on a real box: a run dies in four seconds with "Failed to
 * authenticate. API Error: Attention Required! | Cloudflare" while the same
 * request from the same box with the same token succeeds immediately before
 * and after. Concurrency, payload size, the restricted environment and the
 * capability drop were each tested and each ruled out; the upstream cause is
 * still unidentified.
 *
 * What IS certain is the device's part: it turned one transient upstream
 * hiccup into a dead run and told the owner their box was offline. Claude
 * Code retries ordinary API errors itself, but treats an auth failure as
 * final — reasonably, since a bad key will never come good. Here the key is
 * fine, so the run is worth starting again.
 *
 * Deliberately narrow: an auth/transport shape, and nothing that could be a
 * real refusal of the work.
 */
// unrecognized_model is in the transient set on evidence, not on its name:
// run-ssodhkys died to it minutes after run-5vt51ppv finished a whole build on
// the SAME model string via the same proxy — an entitlement flap upstream,
// the very shape this retry exists for.
const TRANSIENT_FAILURE_RE =
  /failed to authenticate|attention required|cloudflare|502 bad gateway|503|504|gateway time-?out|econnreset|etimedout|enotfound|socket hang up|fetch failed|unrecognized_model/i;

export function isTransientFailure(error: string | null): boolean {
  return typeof error === "string" && TRANSIENT_FAILURE_RE.test(error);
}

/**
 * Commit what the run changed, in its own folder.
 *
 * Never throws: a run that did its work is finished whether or not the
 * history was recorded, and the owner is told either way. Resolves once the
 * attempt is over, so what must follow the commit can wait for it.
 */
async function recordRunWork(run: CodingRun): Promise<void> {
  // No file the tools confirmed — but a run that wrote through its shell and
  // committed there has a commit of its own to record all the same.
  if (run.filesTouched.length === 0) {
    await noteOwnCommit(run);
    return;
  }
  try {
    const outcome = await commitRunWork({
      directory: run.directory,
      runId: run.id,
      task: run.task,
      summary: run.summary,
    });
    if (outcome.committed) {
      run.commit = outcome.sha;
      run.commitError = null;
      pushProgress(run, RUNNER_STEP.committed(outcome.sha, outcome.initialized));
      console.error(`[coding-agent] ${run.id} committed ${outcome.sha}`);
    } else if (outcome.reason !== "no_changes") {
      // On the record, not only in the log: a team reads it before it
      // merges, since a worker whose commit failed has no branch to merge.
      run.commitError = (outcome.detail ?? outcome.reason).slice(0, MAX_ERROR_CHARS);
      pushProgress(run, RUNNER_STEP.notCommitted(outcome.detail ?? outcome.reason));
      console.error(`[coding-agent] ${run.id} not committed: ${outcome.reason}`);
    } else {
      run.commitError = null;
      // Nothing left to stage because the run committed its work ITSELF.
      await noteOwnCommit(run);
    }
    persist(true);
  } catch (err) {
    run.commitError = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
    persist(true);
    console.error("[coding-agent] commit failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * A commit the run made ITSELF, through its shell: the newest commit since it
 * started is its own, and the record carries it — the pull request step and
 * the project's row read `commit`, and a branch two commits ahead of its base
 * is not "nothing was committed" (the angry-pigs run, 2026-09-05). Never
 * throws; a folder that is not its own repository answers nothing.
 */
async function noteOwnCommit(run: CodingRun): Promise<void> {
  try {
    const own = await newestCommitSince(run.directory, run.startedAt);
    if (!own || own === run.commit) return;
    run.commit = own;
    run.commitError = null;
    pushProgress(run, RUNNER_STEP.committedByRun(own));
    console.error(`[coding-agent] ${run.id} committed itself as ${own}`);
    persist(true);
  } catch (err) {
    console.error("[coding-agent] own commit:", err instanceof Error ? err.message : err);
  }
}

/**
 * What follows a settled run, in this order: its work is committed, and only
 * then the review pass — it reads the delivered work as a diff, and starting
 * it before the commit landed would show it the PREVIOUS run's commit as
 * "what you just did".
 *
 * Never after the owner's own Stop or Pause. A run the owner asked to stop
 * can still settle "completed" — the final result event is applied ahead of
 * the stop so a stop that raced the finish keeps the work (see
 * LiveRun.outcome) — but the gesture still means "no more of this", and an
 * automatic follow-up seconds after they pressed Stop would be the box
 * overruling them.
 */
/**
 * Draw the project's icon and its favicons, while the run works.
 *
 * Fired at the START of a run rather than at its end, so the files are usually
 * on disk within fifteen seconds and the run can LINK to them — a favicon that
 * only appeared once the run had written every page would be a file nothing
 * references. Never for a review pass: it resumes in a folder that already had
 * its turn, and the icon is one per project, not one per run.
 *
 * Fire-and-forget on purpose: `ensureProjectIcon` never rejects, the box-wide
 * generation slot serialises a queue of creates, and a project without a
 * picture is cosmetic where a run that waited on one is not.
 */
async function drawProjectIcon(run: CodingRun): Promise<{ icon: string; favicon: boolean }> {
  // The PROJECT's folder name, never the worktree's — a worktree is named
  // after the run, and the icon is one per project. The picture itself is
  // still drawn into `run.directory`, so the run can link to a favicon that
  // is actually beside the pages it writes.
  const folder = run.projectId ?? path.basename(projectDirectoryOf(run));
  const name = (await projectNameOf(run.directory, folder)) ?? folder;
  return ensureProjectIcon({
    id: folder,
    directory: run.directory,
    name,
    description: firstLineOf(run.task),
  });
}

/** The start-of-run hook: only when the owner left pictures on, never for a review, and never for a team's worker or reviewer — their folder is a worktree named after a task, not a project. */
function startProjectIcon(run: CodingRun): void {
  if (!run.media.images || run.reviewOf || (run.team && run.team.role !== "planner")) return;
  void drawProjectIcon(run).catch(() => {
    // ensureProjectIcon already logged; a missing icon never reaches the run.
  });
}

/** After the commit and the wake: the project's assets, the review pass, the pull request. */
async function reviewAndShip(run: CodingRun, ended: "stop" | "pause" | null): Promise<void> {
  await commitProjectAssets(run);
  await registerProjectApp(run);
  const review = ended !== null ? "skipped" : await maybeStartReviewPass(run);
  // After the review pass is decided, not before: when one is starting, the
  // pull request waits for it, because the review's own commits belong in it.
  // Reached after the owner's Stop too — not to open anything then, but so the
  // pull request that was being prepared is settled rather than left pending.
  await maybeOpenPullRequest(run, ended, review);
  // LAST, because it is the step that decides whether "completed" stands — and
  // for the `pr` deliverable the answer is only knowable once the step above
  // has had its go at opening one.
  await enforceDeliverable(run, ended, review);
  // The delivery pipeline, AFTER the gate — which can put this very record
  // back to work, and a pipeline that advanced past a run that is running
  // again would be deploying a folder a live session is still writing in.
  await pipelineAfterSettle(run, ended, review);
  // After ALL of it: the review pass, another go at the deliverable and the
  // review loop all work in this very tree, and `settleRunWorktree` steps
  // aside while any of them is live. Whichever record settles last is the one
  // that finds the tree idle and decides what becomes of it.
  await settleRunWorktree(run);
}

/**
 * The last chance to give a project its icon, and the commit that ships it.
 *
 * A run that started before the picture could be drawn — an unlinked box that
 * was linked mid-run, a generation that lost the slot to a queue of creates —
 * would otherwise have written every page and left the favicon it links to
 * missing. So the same call is made once more at settle, and anything it wrote
 * is committed in its own right: `recordRunWork` has already run, so a favicon
 * that landed after it would sit uncommitted in the folder and the review pass
 * and the pull request would both go out without it.
 *
 * Never throws, like everything else on the settle path, and never waits on the
 * picture for longer than the picture is worth: the upstream call has a
 * two-minute budget of its own, and a slow image endpoint must not be able to
 * hold a finished run's review pass and pull request behind it. When the budget
 * runs out the generation is left running — it still lands the icon, just in a
 * later commit or none — and the run settles.
 */
/**
 * A project whose clawbox.json declares a `port` goes on the desktop when a
 * run in it settles: its icon opens `/apps/<folder>/`, which the box proxies
 * to that port (src/lib/app-proxy.ts). The manifest IS the registration —
 * no tool call, no host or port in any link — and when it names a `start`
 * command the box runs it for a server the run has already stopped. A review
 * pass or a team's run re-reads nothing: the run that wrote the manifest did
 * this.
 */
async function registerProjectApp(run: CodingRun): Promise<void> {
  if (run.reviewOf || run.reviewLoopOf || run.readOnly || run.team) return;
  // The manifest is read where the run WROTE it (its own copy of the project)
  // and the app is registered against the PROJECT folder, which is the one
  // that is still there next week — and the one `listenerOwnedBy` asks about,
  // which a server started inside the worktree still passes, the worktree
  // being inside it.
  const project = projectDirectoryOf(run);
  const id = path.basename(project);
  if (!APP_ID_RE.test(id)) return;
  try {
    const manifest = await readClawboxManifest(run.directory);
    if (!manifest?.port) return;
    // A run ends what it started, its own server included, so "nothing is
    // listening" is the ORDINARY state here, not a fault: the box starts the
    // app from the manifest's `start` and registers it (app-server-start.ts).
    // Only when the project folder carries the same manifest — a run that
    // worked in a copy whose changes are not in the project yet has nothing
    // there to start.
    const inProject = project === run.directory ? manifest : await readClawboxManifest(project);
    // What is started is the PROJECT's server, so what is registered for it is
    // the project's manifest too (its name, its `stripBasePath`), not a copy's.
    const startable = inProject && inProject.port === manifest.port && inProject.start === manifest.start;
    const outcome = startable
      ? await registerOrStartServerApp({ id, directory: project, manifest: inProject, searchPath: runnerPath() })
      : await registerServerApp({ id, directory: project, manifest });
    pushProgress(run, outcome.ok
      ? RUNNER_STEP.onDesktop(manifest.name, id, manifest.port)
      : RUNNER_STEP.notOnDesktop(manifest.port, `${outcome.detail.charAt(0).toLowerCase()}${outcome.detail.slice(1)}`));
    persist(true);
  } catch (err) {
    console.error("[coding-agent] project app:", err instanceof Error ? err.message : err);
  }
}

async function commitProjectAssets(run: CodingRun): Promise<void> {
  if (!run.media.images || run.reviewOf || run.reviewLoopOf) return;
  try {
    const drawn = await Promise.race([
      drawProjectIcon(run),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SETTLE_ICON_BUDGET_MS).unref?.()),
    ]);
    if (!drawn?.favicon) return;
    const outcome = await commitRunWork({
      directory: run.directory,
      runId: run.id,
      task: "Add the project's generated icon and favicon",
      summary: null,
    });
    if (outcome.committed) {
      run.commit = outcome.sha;
      pushProgress(run, RUNNER_STEP.faviconCommitted(outcome.sha));
      persist(true);
    }
  } catch (err) {
    console.error("[coding-agent] project assets:", err instanceof Error ? err.message : err);
  }
}

/**
 * Open the pull request for a finished chain of runs, and start watching its
 * checks — or settle the pull request as never opened, when the chain did not
 * finish. Every way a chain can end through finishRun comes through here, and
 * the ways that do not (a spawn that failed, Stop on a paused run, a restart)
 * settle the phase themselves: a pull request left "opening" is pending for
 * good, which keeps its run out of the history sweeps and the desktop polling
 * for a change that is never coming.
 *
 * "Chain", not "run": with the review pass on, the LAST run to settle is the
 * review, and the branch and the work belong to the run it reviewed. So the
 * pull request is always attributed to the origin run, and this defers while a
 * review pass is running.
 */
async function maybeOpenPullRequest(finished: CodingRun, ended: "stop" | "pause" | null, review: ReviewPassOutcome): Promise<void> {
  try {
    // A review pass is running for this run — wait for it, and let the
    // review's own settle bring us back here. Only when one actually STARTED:
    // maybeStartReviewPass swallows its refusals (the switch off, the slot
    // taken, the harness gone), and deferring on the conditions alone left the
    // pull request waiting for a review that was never going to happen.
    if (review === "started") return;

    // A review-loop turn has no pull request of its own to open: it was
    // started to FIX one that is already open, and its settle belongs to the
    // loop rather than to this step.
    if (finished.reviewLoopOf !== null) {
      await resumeReviewAfterFix(finished, ended);
      return;
    }

    const origin = finished.reviewOf === null ? finished : loadRuns().find((r) => r.id === finished.reviewOf);
    if (!origin) return;

    // A run with NO pull request record of its own may still have opened one
    // itself, because its task said to. That is the defect this branch fixes:
    // `pr.number` was written on the auto-PR path and nowhere else, so a run
    // that ran `gh pr create` in its own turn settled with `pr: null`,
    // `review: null`, and the review loop never engaged at all. Nothing is
    // OPENED down there — an open pull request on the run's own branch is
    // adopted if GitHub has one, and otherwise this stays the no-op it was.
    if (!origin.pr) {
      await adoptRunPullRequest(origin, finished, ended, review);
      return;
    }
    if (origin.pr.phase !== "opening") return;
    const branch = origin.pr.branch ?? runBranchName(origin.id);

    // A pause is not the end of the chain: the run resumes IN PLACE — the
    // same record, the same branch — and its settle comes back here, so the
    // pull request stays "opening" through it. Settling it here closed the
    // pull request for good on the first pause, and the resumed run's
    // completion then found nothing left to open. A paused run is held, not
    // history (see isHeld), so this is not the pending-forever the sweeps
    // suffer from; the one way a paused run ends without coming back here —
    // Stop on it — settles the pull request in stopRun.
    if (finished.status === "paused") return;
    // The owner's Stop means no more of this — pushing their code to GitHub
    // seconds after they pressed it would be the box overruling them. A run
    // that completed under the gesture (the result raced the kill) is kept
    // "completed", but still not pushed.
    if (ended !== null) {
      settlePr(origin, "failed", `${ended === "pause" ? "Paused" : "Stopped"} before a pull request was opened. The work stays on ${branch}.`);
      return;
    }
    if (origin.status !== "completed") {
      settlePr(origin, "failed", `The run did not finish (${origin.status}), so no pull request was opened. The work stays on ${branch}.`);
      return;
    }
    if (!(await getAutoPr())) {
      settlePr(origin, "failed", `Pull requests were switched off while the run worked, so none was opened. The work stays on ${branch}.`);
      return;
    }
    if (!origin.pr.branch || !origin.pr.base) {
      settlePr(origin, "failed", "The run's branch was not recorded, so no pull request was opened.");
      return;
    }
    // Held in locals because the `await`s below drop the narrowing: `origin.pr`
    // is a mutable property, so after any suspension TypeScript is right to
    // read `base` as nullable again — and the progress line below must name the
    // branch this pull request was actually opened into, not "null".
    const prBase = origin.pr.base;
    const prBranch = origin.pr.branch;

    // Nothing was committed anywhere in the chain: there is no diff to review
    // and nothing to merge.
    if (!origin.commit && !finished.commit) {
      settlePr(origin, "blocked", "Nothing was committed, so there is no pull request to open.");
      return;
    }

    // ASKED BEFORE ONE IS OPENED: the run may have opened its own already, and
    // `gh pr create` over a branch that has one fails. Failing there settled the
    // pull request record "failed" and left the run's real pull request
    // unwatched — the same silence the `pr: null` case above suffered from.
    const mine = await findOpenPullRequestForBranch(origin.directory, prBranch);
    let number: number;
    let url: string | null;
    let base = prBase;
    let foundBy: PrFoundBy;
    if (mine) {
      // A Fix CI run's work is for the pull request that is already open: its
      // branch goes up, or the checks it was started for never see the fix.
      // The ORIGIN's mark — the run settling here may be its review pass.
      if (origin.ciFixOf) await pushFixCiBranch(origin, prBranch);
      number = mine.number;
      url = mine.url;
      // GitHub's answer for the base, not the record's intention: a run that
      // aimed its own pull request somewhere else is the reason to ask at all,
      // and the merge guard is about the branch it ACTUALLY targets.
      base = mine.base ?? prBase;
      foundBy = "adopted";
    } else {
      // Read at the moment it is opened, like the auto-PR switch above: the
      // owner who changed it while the run worked meant this pull request.
      const taskMode = await getPrBodyIncludesTask();
      const created = await openPullRequest({
        directory: origin.directory,
        branch: prBranch,
        base: prBase,
        title: pullRequestTitle(origin.task, { hostNames: boxHostNames() }),
        body: prBody(origin, finished, taskMode),
        // A draft until its checks pass: the watcher readies it then, and that
        // is when CodeRabbit gives the one review it gives a pull request.
        draft: true,
      });
      if (!created.ok) {
        settlePr(origin, "failed", created.detail);
        return;
      }
      number = created.number;
      url = created.url;
      foundBy = "opened";
    }

    // The review's verdict gates the merge as well as the checks: they answer
    // different questions, and a green suite over a review that failed is not
    // consent to merge. A review that was due and could not start is no
    // verdict either. Written on the record — see PrState.reviewOk.
    const reviewOk = finished.reviewOf !== null ? finished.status === "completed" : review !== "refused";
    await beginPullRequestWatch(origin, { number, url, branch: prBranch, base, foundBy, reviewOk });
  } catch (err) {
    console.error(`[coding-agent] pull request for ${finished.id} not opened:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Put the pull request on the run, start the watcher it belongs to, and say so.
 *
 * ONE place for it, because there are now two ways in — the box opened it, or
 * the run did and the settle adopted it — and they have to leave the same
 * record behind. Written as a second copy each, the adopted pull request would
 * sooner or later get a phase and no loop, which is the defect this branch
 * exists to fix wearing a different hat.
 */
async function beginPullRequestWatch(origin: CodingRun, input: {
  number: number;
  url: string | null;
  branch: string | null;
  /** The branch it actually targets, as GitHub answered it. */
  base: string | null;
  foundBy: PrFoundBy;
  reviewOk: boolean;
}): Promise<void> {
  // The owner's rounds setting, read HERE and frozen on the loop for the reason
  // every other run setting is frozen: a loop that had its cap raised or
  // lowered under it would be a different promise from the one the run started
  // under.
  const maxRounds = await getReviewRounds();
  const now = Date.now();
  origin.pr = {
    phase: maxRounds > 0 ? "review" : "waiting",
    number: input.number,
    url: input.url,
    branch: input.branch,
    base: input.base,
    // Whatever an earlier phase counted; the watcher overwrites it on its first
    // poll, and an adopted pull request has nothing counted yet.
    checks: origin.pr?.checks ?? emptyChecks(),
    detail: null,
    startedAt: now,
    endedAt: null,
    reviewOk: input.reviewOk,
    foundBy: input.foundBy,
    readyAt: null,
  };
  pushProgress(origin, input.foundBy === "adopted"
    ? RUNNER_STEP.pullRequestAdopted(input.number, input.base)
    : RUNNER_STEP.pullRequestOpened(input.number, input.base));
  if (maxRounds > 0) {
    origin.review = {
      prNumber: input.number,
      url: input.url,
      base: input.base,
      round: 0,
      maxRounds,
      state: "polling",
      checks: [],
      unresolvedThreads: 0,
      reviewDecision: null,
      lastPolledAt: null,
      roundStartedAt: now,
      detail: null,
      fixRunId: null,
      fixMode: null,
      fixDetail: null,
      readyAt: null,
      codeRabbitAskedFor: null,
    };
  }
  persist(true);
  console.error(`[coding-agent] ${origin.id} ${input.foundBy} PR #${input.number} into ${input.base}`);

  // Two watchers, never both: the review loop owns the pull request when the
  // owner has rounds to spend, and the older checks-only watcher keeps a box
  // that set the rounds to 0 behaving exactly as it did before the loop
  // existed.
  if (maxRounds > 0) watchReviewLoop(origin.id);
  else watchPullRequest(origin.id);

}

/**
 * Adopt a pull request the RUN opened for itself.
 *
 * Reached only for a run with no pull-request record at all: the auto-PR switch
 * was off when it started, or the folder was not a repository yet. That run is
 * still the ordinary way work reaches GitHub on this device — its task says to
 * open a pull request and it runs `gh pr create` — and until this existed the
 * box had no number on the record, so the review loop never engaged.
 *
 * The branch is the run's OWN and never a guess at whatever HEAD happens to be:
 * `pr.branch` is gone by definition here, so the worktree's is the one branch
 * this box knows belongs to this run alone. A run that shared a branch with its
 * project is left alone, because `gh pr list --head` on a shared branch would
 * answer with somebody else's pull request and the loop would push its rounds
 * onto their work.
 */
async function adoptRunPullRequest(
  origin: CodingRun,
  finished: CodingRun,
  ended: "stop" | "pause" | null,
  review: ReviewPassOutcome,
): Promise<void> {
  // The same three gates the opening path applies, in the same order and for
  // the same reasons: a pause is not the end of the chain, the owner's Stop
  // means no more of this, and a run that did not finish has nothing to stand
  // behind.
  if (finished.status === "paused") return;
  if (ended !== null || origin.status !== "completed") return;
  // With the loop switched off there is nothing to adopt INTO. The older
  // checks-only watcher exists to merge what this box opened, and pointing it
  // at a pull request the box did not open would be a new behaviour under an
  // owner setting that promises the opposite.
  if ((await getReviewRounds()) <= 0) return;
  const branch = origin.worktree?.branch;
  if (!branch) return;

  const mine = await findOpenPullRequestForBranch(origin.directory, branch);
  if (!mine) return;
  // The same push the opening path makes for a Fix CI run: with the auto-PR
  // switch off this is the one way its fix reaches the pull request.
  if (origin.ciFixOf) await pushFixCiBranch(origin, branch);

  // Re-read: the `gh` call above is a subprocess, and the owner may have
  // cleared the run or a second settle of the chain may have got here first.
  const live = loadRuns().find((r) => r.id === origin.id);
  if (!live || live.pr) return;
  await beginPullRequestWatch(live, {
    number: mine.number,
    url: mine.url,
    branch,
    base: mine.base,
    foundBy: "adopted",
    // The same verdict the opening path records, from the same two facts: the
    // review pass either ran over this chain and completed, or was never due.
    reviewOk: finished.reviewOf !== null ? finished.status === "completed" : review !== "refused",
  });
}

/** First line of the task, trimmed to a title's length, for what stays on the
 *  box. A pull request's title is `pullRequestTitle`, which redacts. */
function firstLineOf(task: string): string {
  return taskTitle(task, 72) || "ClawBox coding agent";
}

/**
 * The pull request's body: composed and redacted in @/lib/coding-pr-body, so
 * the task, the summary and the evidence below it reach GitHub without the
 * owner's paths, addresses, names or tokens (TASK-1366). `origin.task` itself
 * is not touched — it is what the run was given and what its page shows.
 */
function prBody(origin: CodingRun, last: CodingRun, taskMode: PrBodyTaskMode): string {
  const hostNames = boxHostNames();
  const body = composePullRequestBody({
    task: origin.task,
    runId: origin.id,
    commit: origin.commit,
    reviewRunId: last.reviewOf ? last.id : null,
    summary: origin.summary,
    taskMode,
  }, { hostNames });
  // What the review pass actually SAW, when it looked. The reviewing run first,
  // because its screenshots are of the finished work; the origin run's own
  // verification shots after. A body with nothing to show gains nothing. The
  // descriptions are the run's own words about its pages, and a page served on
  // the LAN is described by its address — so they are redacted too.
  const evidence = visualEvidenceSection(last, origin);
  return withEvidenceSection(body, evidence === null ? null : redactForGitHub(evidence));
}

/**
 * The evidence block for a pull request, or null when no picture was kept.
 *
 * Read from disk at the moment the body is written, like the artifacts listing
 * the run page draws: nothing about a screenshot is persisted on the record, so
 * this is the only place the two could ever disagree, and it does not.
 */
function visualEvidenceSection(last: CodingRun, origin: CodingRun): string | null {
  try {
    return renderEvidenceSection(collectVisualEvidence([last.id, origin.id]));
  } catch (err) {
    console.error("[coding-agent] could not read the run's visual evidence:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Record a terminal PR phase on the run and persist it. */
/**
 * Push a Fix CI run's branch before its pull request is watched again, so the
 * checks run on the fix. A push that fails is said in the log, never as a
 * merge that did not happen: the watcher then reads what GitHub has.
 */
async function pushFixCiBranch(origin: CodingRun, branch: string): Promise<void> {
  const pushed = await pushBranch(origin.directory, branch);
  if (!pushed.ok) console.error(`[coding-agent] ${origin.id}: could not push the Fix CI branch ${branch}: ${pushed.detail}`);
}

/**
 * The attempt a "Fix CI" continuation of `previous` would be (1-based), or the
 * refusal: no failed CI on record, a Fix CI already started from this failure
 * (but the queued one itself, when it starts), or the chain's attempts used
 * up. Bounded: the failure of each fix is what offers the next, and only
 * MAX_CI_FIX_ATTEMPTS of them.
 */
export function ciFixAttempt(previous: Pick<CodingRun, "ci" | "ciFixOf">, queuedRunId: string | null): number {
  if (!previous.ci) {
    throw new CodingAgentError("invalid", "That run's pull request has no failed CI on record, so there is nothing for a Fix CI run to fix.");
  }
  if (previous.ci.fixRunId && previous.ci.fixRunId !== queuedRunId) {
    throw new CodingAgentError("invalid", `A Fix CI run was already started from that failure (${previous.ci.fixRunId}). Follow that one instead.`);
  }
  const attempt = (previous.ciFixOf?.attempt ?? 0) + 1;
  if (attempt > MAX_CI_FIX_ATTEMPTS) {
    throw new CodingAgentError("invalid", `That pull request has had its ${MAX_CI_FIX_ATTEMPTS} Fix CI runs; what still fails is the owner's to look at.`);
  }
  return attempt;
}

/**
 * The pull request a run watched ended on FAILING checks: read the failing
 * jobs' logs (bounded — readFailedCheckLogs), name the failing tests and the
 * files, and put it on the record (CodingRun.ci) and its feed, for the run's
 * page and coding_agent_status to offer a "Fix CI" continuation from. `known`
 * is the checks list the caller already holds; without it GitHub is asked.
 * Best effort: a failure that cannot be read leaves the run as it was.
 */
async function noteCiFailure(runId: string, prNumber: number, known?: readonly ReviewCheck[]): Promise<void> {
  try {
    const run = loadRuns().find((r) => r.id === runId);
    if (!run) return;
    let checks = known?.length ? [...known] : null;
    if (!checks) {
      const snapshot = await readReviewSnapshot(run.directory, prNumber);
      checks = "error" in snapshot ? [] : snapshot.checks;
    }
    const failed = checks.filter((c) => c.state === "fail");
    if (!failed.length) return;
    const logs = await readFailedCheckLogs(run.directory, failed);
    const current = loadRuns().find((r) => r.id === runId);
    if (!current) return;
    const failure = readCiFailure(prNumber, logs);
    current.ci = { ...failure, attempt: current.ciFixOf?.attempt ?? 0, fixRunId: null };
    pushProgress(current, ciFailureLine(failure));
    persist(true);
  } catch (err) {
    console.error(`[coding-agent] ${runId}: could not read the failed CI:`, err instanceof Error ? err.message : err);
  }
}

function settlePr(run: CodingRun, phase: "merged" | "blocked" | "failed", detail: string | null): void {
  if (!run.pr) return;
  run.pr = { ...run.pr, phase, detail, endedAt: Date.now() };
  pushProgress(run, phase === "merged" ? RUNNER_STEP.merged : RUNNER_STEP.notMerged(detail ?? phase));
  persist(true);
}

/**
 * A watcher's own merge, and the one race it now has: GitHub's auto-merge
 * lands the same pull request in the seconds between the poll that saw it
 * green and this call, and `gh pr merge` then fails on a pull request that is
 * merged. That is a merge, and it is recorded as one.
 */
async function mergeOrFindMerged(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const merged = await mergePullRequest(dir, number);
  if (merged.ok) return merged;
  const facts = await readAutoMergeFacts(dir, number);
  return !("error" in facts) && facts.state === "MERGED" ? { ok: true } : merged;
}

/** How often the checks-only watcher, which polls every few seconds, looks at
 *  auto-merge. The review loop looks on every one of its polls. */
const AUTO_MERGE_LOOK_MS = 60_000;

/** Said after a watcher's last word when GitHub's auto-merge is still on. */
const AUTO_MERGE_ON_NOTE = "GitHub's auto-merge is on for it, so it merges by itself the moment its required checks pass.";

/** Where reconcileAutoMerge left GitHub's auto-merge. */
interface AutoMergeReconciled {
  /** On once it was done, or null when that is not known. */
  on: boolean | null;
  /** GitHub's own words when auto-merge had to go OFF and would not, or null. */
  offFailed: string | null;
}

/**
 * A watcher's last word, with what GitHub's auto-merge will still do after it.
 *
 * A turn-off that failed is said first and plainly: the watcher is ending, so
 * nothing here will try again, and over a hold label or a base of main that
 * is a merge the owner asked for nobody to make.
 */
function withAutoMergeNote(detail: string | null, autoMerge: AutoMergeReconciled | null): string | null {
  const note = autoMerge?.offFailed
    ? `ClawBox could not turn GitHub's auto-merge off, so it may still merge by itself — turn it off on GitHub. ${autoMerge.offFailed}`
    : autoMerge?.on === true ? AUTO_MERGE_ON_NOTE : null;
  if (!note) return detail;
  return detail ? `${detail} ${note}` : note;
}

/**
 * Bring GitHub's auto-merge for a watched pull request in line with what the
 * box would do itself — see decideAutoMerge.
 *
 * WHY. A watcher merges on its next poll, and only for as long as it polls:
 * the checks-only watcher gives up after half an hour and the review loop
 * after an hour a round, which a slow install check and a rate-limited
 * reviewer outlast between them. A pull request that went green after that sat
 * open until somebody came by, measured at ten to sixteen hours overnight.
 * Auto-merge hands the last step to GitHub, which merges the moment the
 * required checks pass whether or not anything here is still looking.
 *
 * Best-effort by construction: every `gh` failure is logged and the watcher
 * goes on exactly as it would have without this. Answers whether auto-merge is
 * on once it is done (null when that is not known), and GitHub's refusal when
 * it had to go off and would not — see withAutoMergeNote.
 */
async function reconcileAutoMerge(
  runId: string,
  input: { refusal: string | null; outstanding: string | null; early: boolean },
): Promise<AutoMergeReconciled> {
  const unknown: AutoMergeReconciled = { on: null, offFailed: null };
  const run = loadRuns().find((r) => r.id === runId);
  const number = run?.pr?.number;
  if (!run?.pr || typeof number !== "number") return unknown;

  const facts = await readAutoMergeFacts(run.directory, number);
  if ("error" in facts) {
    console.error(`[coding-agent] ${runId} could not read auto-merge for PR #${number}: ${facts.error}`);
    return unknown;
  }
  const failedAt = run.pr.autoMergeFailedAt ?? null;
  const stance = decideAutoMerge({
    facts,
    refusal: input.refusal,
    outstanding: input.outstanding,
    early: input.early,
    mayTry: failedAt === null || Date.now() - failedAt >= AUTO_MERGE_RETRY_MS,
    armedAt: run.pr.autoMergeAt ?? null,
  });
  if (stance.action === "none") return { on: facts.enabled, offFailed: null };

  const turningOn = stance.action === "enable";
  const done = turningOn ? await enableAutoMerge(run.directory, number) : await disableAutoMerge(run.directory, number);
  // Re-read: the `gh` calls above are subprocesses, and the owner may have
  // cleared the run under them.
  const current = loadRuns().find((r) => r.id === runId);
  if (!current?.pr || current.pr.number !== number) return unknown;
  if (!done.ok) {
    console.error(`[coding-agent] ${runId} could not turn auto-merge ${turningOn ? "on" : "off"} for PR #${number}: ${done.detail}`);
    if (turningOn) {
      current.pr = { ...current.pr, autoMergeFailedAt: Date.now() };
      persist(true);
    }
    return { on: facts.enabled, offFailed: turningOn ? null : done.detail };
  }
  current.pr = turningOn
    ? { ...current.pr, autoMergeAt: Date.now(), autoMergeFailedAt: null }
    : { ...current.pr, autoMergeAt: null };
  pushProgress(current, stance.action === "enable" ? RUNNER_STEP.autoMergeOn(number) : RUNNER_STEP.autoMergeOff(stance.reason));
  persist(true);
  console.error(`[coding-agent] ${runId} turned auto-merge ${turningOn ? "on" : "off"} for PR #${number}`);
  return { on: turningOn, offFailed: null };
}

/**
 * One poll of a pull-request, review or deployment watcher, tracked like the
 * settle path it continues.
 *
 * A poll is a `gh` call made from the run's own folder with the
 * box's HOME, and every one of them used to be started and forgotten — the
 * review loop's first look fires the moment the pull request is opened, which
 * is while the settle chain a teardown waits for is still finishing. The drain
 * then answered with `gh` still going inside the tree the suite was removing,
 * and CI failed with `ENOTEMPTY: directory not empty, rmdir '.../home'` in
 * `coding-agent-durable-completion.test.ts` (PR #928, touching none of this):
 * `rmSync` empties a folder once and then only retries the `rmdir`, so one entry
 * `gh` wrote under HOME in that window was enough. Pinned by
 * `coding-agent-reset-drain.test.ts`.
 *
 * `watchers` is the loop's own set: the test reset clears it, and a poll armed
 * before that — or re-armed by a poll the drain was waiting for — ends here
 * instead of spawning `gh` into whatever the next test is doing. On the box
 * nothing clears the sets but the loops themselves, so this never stops a live
 * one.
 */
function runWatcherPoll(watchers: Set<string>, runId: string, poll: () => Promise<void>): void {
  if (!watchers.has(runId)) return;
  trackSettleWork(poll());
}

/** Arm a watcher's next poll — see `runWatcherPoll`. */
function scheduleWatcherPoll(watchers: Set<string>, runId: string, poll: () => Promise<void>, delayMs: number): void {
  if (!watchers.has(runId)) return;
  const timer = setTimeout(() => { runWatcherPoll(watchers, runId, poll); }, delayMs);
  // Never hold the process open for a pull request or a build.
  timer.unref?.();
}

/** Runs whose checks are being polled right now, so a restart or a second
 *  settle cannot start two watchers for one pull request. */
const prWatchers = store.prWatchers;

/**
 * Poll a pull request's checks until they decide something.
 *
 * A timer in the web server, which CLAUDE.md calls the one long-lived ClawBox
 * process — so it is unref()'d (it must never hold the process open), capped by
 * PR_MAX_WAIT_MS (through decideMerge when the pull request can be read, and
 * here when it cannot), and single-instance per run. Everything it decides on
 * is read from the record each tick, the review verdict included, so a watcher
 * rebuilt after a restart decides exactly as the first one did.
 */
function watchPullRequest(runId: string): void {
  if (prWatchers.has(runId)) return;
  prWatchers.add(runId);
  // In the watcher's closure rather than on the record: a watcher rebuilt
  // after a restart looking again at once is what should happen anyway.
  let autoMergeLookedAt = 0;

  const tick = async (): Promise<void> => {
    const run = loadRuns().find((r) => r.id === runId);
    if (!run?.pr || run.pr.phase !== "waiting") {
      prWatchers.delete(runId);
      return;
    }
    if (run.pr.number === null) {
      // A waiting pull request whose number is gone (a hand-edited or damaged
      // record) can never be read; settled, not left pending for good.
      settlePr(run, "failed", "The pull request's number was lost, so its checks cannot be read.");
      prWatchers.delete(runId);
      return;
    }
    // Captured before the record is reassigned below — the assignment is what
    // loses the null-narrowing TypeScript did on the guard above.
    const prNumber = run.pr.number;
    const snapshot = await readPullRequest(run.directory, prNumber);
    if ("error" in snapshot) {
      // A transient read says nothing, so the wait goes on — but under the
      // same ceiling a check that never completes gets. decideMerge, which
      // holds that ceiling, is never reached from here, and without this one
      // a `gh` that kept failing (a sign-in that expired, a box offline for
      // the evening) left the pull request "waiting" for good: pending in the
      // history, and polled again after every restart by the boot sweep.
      if (Date.now() - run.pr.startedAt >= PR_MAX_WAIT_MS) {
        settlePr(run, "blocked", `Gave up waiting: the pull request could not be read from GitHub. It may still be open. ${snapshot.error}`);
        prWatchers.delete(runId);
        return;
      }
      schedule();
      return;
    }
    run.pr = { ...run.pr, checks: snapshot.checks };
    persist(true);

    const readyAt = typeof run.pr.readyAt === "number" ? run.pr.readyAt : null;
    const verdict = decideMerge({
      snapshot,
      // From the moment it was readied, once it was: the review that starts
      // then gets the whole wait, not what the suite left of it.
      waitedMs: Date.now() - (readyAt ?? run.pr.startedAt),
      reviewOk: run.pr.reviewOk,
      sinceReadyMs: readyAt === null ? null : Date.now() - readyAt,
    });

    // GitHub's auto-merge follows the verdict: on while this watcher would
    // merge, off where it would not — see reconcileAutoMerge. Every minute
    // while waiting, and always on the way out, so a watcher that gave up at
    // its ceiling leaves it on and one that refused leaves it off. Never
    // before the merge this watcher is about to make itself.
    let autoMergeState: AutoMergeReconciled | null = null;
    if (verdict.action !== "merge" && snapshot.state === "OPEN"
      && (verdict.action === "block" || Date.now() - autoMergeLookedAt >= AUTO_MERGE_LOOK_MS)) {
      autoMergeLookedAt = Date.now();
      autoMergeState = await reconcileAutoMerge(runId, {
        refusal: run.pr.reviewOk ? null : "the automatic review pass did not finish cleanly",
        outstanding: snapshot.checks.failed > 0
          ? "a check failed"
          : snapshot.mergeable === "CONFLICTING" ? "the branch conflicts with its base" : null,
        // Opened or readied moments ago: its checks are still arriving.
        early: Date.now() - (readyAt ?? run.pr.startedAt) < NO_CHECKS_GRACE_MS,
      });
    }

    if (verdict.action === "wait") { schedule(); return; }
    if (verdict.action === "ready") {
      const readied = await markPullRequestReady(run.directory, prNumber);
      const current = loadRuns().find((r) => r.id === runId);
      if (!current?.pr || current.pr.phase !== "waiting") { prWatchers.delete(runId); return; }
      if (readied.ok) {
        current.pr = { ...current.pr, readyAt: Date.now() };
        persist(true);
        console.error(`[coding-agent] ${runId} marked PR #${prNumber} ready for review`);
      } else if (Date.now() - current.pr.startedAt >= PR_MAX_WAIT_MS) {
        // Retried on the next poll, under the ceiling every other wait has.
        settlePr(current, "blocked", readied.detail);
        prWatchers.delete(runId);
        return;
      }
      schedule();
      return;
    }
    if (verdict.action === "block") {
      // Failing checks: what failed is read and offered as a Fix CI first.
      if (snapshot.checks.failed > 0) await noteCiFailure(runId, prNumber);
      // Re-read: reconcileAutoMerge may have waited on `gh`.
      const current = loadRuns().find((r) => r.id === runId);
      if (current?.pr?.phase === "waiting") settlePr(current, "blocked", withAutoMergeNote(verdict.detail, autoMergeState));
      prWatchers.delete(runId);
      return;
    }
    const merged = await mergeOrFindMerged(run.directory, prNumber);
    settlePr(run, merged.ok ? "merged" : "blocked", merged.ok ? null : merged.detail);
    prWatchers.delete(runId);
  };

  const schedule = () => { scheduleWatcherPoll(prWatchers, runId, tick, POLL_INTERVAL_MS); };

  schedule();
}

/**
 * Pick up pull requests left pending by a restart.
 *
 * Same reason the email approval poller is restarted at boot: a box that
 * reboots mid-wait would otherwise leave the run showing "waiting for checks"
 * forever, with nothing polling. One left "opening" on a run the restart
 * ended has no future at all — the settle that would have opened it died
 * with the previous server, and reconcileAfterRestart has already marked the
 * run that was still working failed — so it is settled here the way that run
 * was, with the branch named for the owner to push themselves. A paused
 * run's is left alone: the run is kept, and its resume opens it.
 */
/** Is a review-loop fix turn for this run still going in this process? */
function liveFixTurnFor(originId: string): boolean {
  const list = loadRuns();
  for (const id of live.keys()) {
    if (list.find((r) => r.id === id)?.reviewLoopOf === originId) return true;
  }
  return false;
}

export function resumePullRequestWatches(): void {
  for (const run of loadRuns()) {
    // The review loop first: its phase is pending too, and it owns the pull
    // request when it is there.
    if (isReviewPending(run.review) && run.review) {
      // "working" cannot survive a restart: the round's process died with the
      // previous server and reconcileAfterRestart has already marked that run
      // failed, so nothing will ever come back to resumeReviewAfterFix for it.
      // Whatever it committed is on disk; polling again is what picks it up.
      if (run.review.state === "working") {
        // Unless the fix turn SURVIVED the restart in its own scope and was
        // reattached (reconcileAfterRestart, which runs before this): it is
        // still working and will come back to resumeReviewAfterFix itself when
        // it settles. Polling beside it would drive one loop from two places —
        // a round opened over a fix that is still being written.
        if (liveFixTurnFor(run.id)) continue;
        run.review = { ...run.review, state: "polling", roundStartedAt: Date.now() };
        persist(true);
      }
      watchReviewLoop(run.id);
      continue;
    }
    if (!isPrPending(run.pr) || !run.pr) continue;
    if (run.pr.phase === "waiting") {
      watchPullRequest(run.id);
    } else if (!isHeld(run.status)) {
      // Held, not live: a paused run survives the restart with its record
      // (see the restart reconciliation) and resumes in place, so its
      // "opening" pull request is still coming — settling it here meant the
      // resumed run completed with nothing left to open.
      settlePr(run, "failed", `The ClawBox web server restarted before the pull request was opened. The work stays on ${run.pr.branch ?? runBranchName(run.id)}.`);
    }
  }
}

/**
 * The review loop: what happens to a pull request AFTER it is opened.
 *
 * Runs whose pull request is watched by the loop right now, so a restart, a
 * second settle or a fix run coming home cannot start two loops for one pull
 * request. The twin of `prWatchers`, and separate from it because the two
 * watchers are never both on one pull request.
 */
const reviewWatchers = store.reviewWatchers;

/** What a pull request the loop cleared but was not allowed to merge says. */
const REVIEW_CLEAN_DETAIL =
  "Everything is green and nothing is unresolved. Merge it when you are ready — ClawBox only merges by itself when you switch that on.";

/**
 * Record where the loop ended, and close the pull request record with it.
 *
 * The pull request record is what the sweeps and the desktop read as "still
 * pending", so a loop that ended without settling `pr` would keep its run out
 * of the history for good and keep every open desktop polling for a change
 * that is never coming — exactly the failure mode a pull request left
 * "opening" has.
 */
function settleReview(
  run: CodingRun,
  state: "clean" | "merged" | "needs_owner" | "failed",
  detail: string | null,
): void {
  if (!run.review) return;
  const said = detail ?? (state === "clean" ? REVIEW_CLEAN_DETAIL : null);
  run.review = { ...run.review, state, detail: said, lastPolledAt: Date.now() };
  // Over to the owner with checks still failing: what failed is read and
  // offered as a Fix CI, the way the checks watcher's red ending is.
  if (state === "needs_owner" && run.review.prNumber && run.review.checks.some((c) => c.state === "fail")) {
    trackSettleWork(noteCiFailure(run.id, run.review.prNumber, run.review.checks));
  }
  if (isPrPending(run.pr)) {
    // "blocked" is the pull request phase for BOTH endings that leave it open:
    // green-and-waiting-for-you and out-of-rounds. The review state beside it
    // is what tells those two apart, and it is what the card words.
    settlePr(run, state === "merged" ? "merged" : state === "failed" ? "failed" : "blocked", said);
  } else {
    persist(true);
  }
  console.error(`[coding-agent] ${run.id} review loop ended: ${state}`);
}

/**
 * Watch one pull request, and hand what GitHub says back to the harness.
 *
 * A timer in the web server like `watchPullRequest`, and held to the same
 * rules: unref()'d so it can never hold the process open, single-instance per
 * run, and everything it decides on is re-read from the record each tick — so
 * a loop rebuilt after a restart decides exactly as the first one did.
 *
 * The poll interval is minutes rather than the checks watcher's seconds: a
 * round costs a whole Claude Code turn, the things it waits for (a CI run, a
 * reviewer) move on that scale, and `gh` is a subprocess spawn per call.
 */
function watchReviewLoop(runId: string): void {
  if (reviewWatchers.has(runId)) return;
  reviewWatchers.add(runId);

  const stop = () => { reviewWatchers.delete(runId); };

  const tick = async (): Promise<void> => {
    const run = loadRuns().find((r) => r.id === runId);
    // "working" is not this timer's state: a fix run is out, and its settle
    // brings the loop back through resumeReviewAfterFix.
    if (!run?.review || run.review.state !== "polling") { stop(); return; }
    const review = run.review;
    const waitedMs = Date.now() - review.roundStartedAt;

    const snapshot = await readReviewSnapshot(run.directory, review.prNumber);
    if ("error" in snapshot) {
      // A transient read says nothing, so the round goes on — under the same
      // ceiling a check that never completes gets. Without it a `gh` that kept
      // failing (a sign-in that expired, a box offline for the evening) would
      // leave the loop polling for good, and the run pending in the history.
      if (waitedMs >= REVIEW_MAX_WAIT_MS) {
        settleReview(run, "needs_owner", `Gave up waiting: the pull request could not be read from GitHub. It may still be open. ${snapshot.error}`);
        stop();
        return;
      }
      schedule();
      return;
    }

    run.review = {
      ...review,
      checks: snapshot.checks,
      unresolvedThreads: snapshot.threads.length,
      reviewDecision: snapshot.reviewDecision,
      lastPolledAt: Date.now(),
    };
    persist(true);

    // Read every tick rather than frozen with the rounds: the rounds shape
    // what the run was promised, but the merge is a consent, and an owner who
    // switches it off while a loop runs has said no to THIS merge.
    const autoMerge = await getAutoMerge();
    const verdict = decideReviewRound({
      snapshot,
      round: review.round,
      maxRounds: review.maxRounds,
      waitedMs,
      autoMerge,
      // The automatic review pass's verdict, recorded when the pull request was
      // opened. The checks-only watcher has always gated its merge on it
      // (decideMerge), and the loop has to as well: a green suite over a review
      // that did not finish cleanly answers a different question, and without
      // this a run whose review pass failed was merged the moment CI went
      // green. Read off the record each tick like everything else, so a loop
      // rebuilt after a restart decides as the first one did.
      reviewOk: run.pr?.reviewOk !== false,
      base: review.base,
      sinceReadyMs: typeof review.readyAt === "number" ? Date.now() - review.readyAt : null,
      codeRabbitAskedFor: review.codeRabbitAskedFor ?? null,
    });

    // GitHub's auto-merge follows the round: on while nothing is outstanding
    // and the box may merge, off while a round is due or the owner has said
    // no — see reconcileAutoMerge. Never before the merge this tick is about
    // to make itself, and not over a pull request that is no longer open.
    let autoMergeState: AutoMergeReconciled | null = null;
    if (verdict.action !== "merge" && snapshot.state === "OPEN") {
      autoMergeState = await reconcileAutoMerge(runId, {
        refusal: !autoMerge
          ? "merging by itself is switched off"
          : run.pr?.reviewOk === false ? "the automatic review pass did not finish cleanly" : null,
        outstanding: autoMergeOutstanding(snapshot, waitedMs),
        // A head pushed moments ago has checks still arriving — its CodeRabbit
        // status among them — so nothing is turned on before the grace is out.
        early: waitedMs < REVIEW_NO_CHECKS_GRACE_MS,
      });
      // Re-read: the owner may have stopped the loop while `gh` was answering.
      if (loadRuns().find((r) => r.id === runId)?.review?.state !== "polling") { stop(); return; }
    }

    if (verdict.action === "wait") { schedule(); return; }
    if (verdict.action === "done") {
      const current = loadRuns().find((r) => r.id === runId) ?? run;
      const said = verdict.detail ?? (verdict.state === "clean" ? REVIEW_CLEAN_DETAIL : null);
      settleReview(current, verdict.state, verdict.state === "merged" ? said : withAutoMergeNote(said, autoMergeState));
      stop();
      return;
    }
    if (verdict.action === "ready" || verdict.action === "ask_coderabbit") {
      // Neither is a round: nothing goes to the harness. Each starts something
      // on GitHub (the review, or its status on this head), so the round's
      // clock restarts with it, and the grace in codeRabbitGate measures "just
      // asked" rather than "asked an hour ago".
      const readying = verdict.action === "ready";
      const done = readying
        ? await markPullRequestReady(run.directory, review.prNumber)
        : await requestCodeRabbitReview(run.directory, review.prNumber);
      const current = loadRuns().find((r) => r.id === runId);
      if (!current?.review || current.review.state !== "polling") { stop(); return; }
      if (done.ok) {
        const now = Date.now();
        current.review = readying
          ? { ...current.review, readyAt: now, roundStartedAt: now }
          : { ...current.review, codeRabbitAskedFor: snapshot.headSha ?? "unknown", roundStartedAt: now };
        persist(true);
        console.error(`[coding-agent] ${runId} ${readying ? "marked PR ready for review" : "asked CodeRabbit to review the head"} (#${review.prNumber})`);
      } else if (waitedMs >= REVIEW_MAX_WAIT_MS) {
        // Retried on the next poll, under the ceiling every other wait has.
        settleReview(current, "needs_owner", done.detail);
        stop();
        return;
      }
      schedule();
      return;
    }
    if (verdict.action === "merge") {
      const merged = await mergeOrFindMerged(run.directory, review.prNumber);
      settleReview(run, merged.ok ? "merged" : "needs_owner", merged.ok ? null : merged.detail);
      stop();
      return;
    }

    // Something to fix. The round is spent here, not on the poll that found it.
    const spawned = await startFixRun(runId, snapshot);
    if (spawned === "started") { stop(); return; }
    if (spawned === "retry") {
      // The box was busy with another run, or the harness is not ready this
      // minute. Neither is this pull request's fault, so the round is NOT
      // spent — the loop simply looks again, under the same wait ceiling.
      if (waitedMs >= REVIEW_MAX_WAIT_MS) {
        const current = loadRuns().find((r) => r.id === runId);
        if (current) {
          settleReview(current, "needs_owner", `${describeProblems(reviewProblems(snapshot))} The box could not start a review round in time.`);
        }
        stop();
        return;
      }
      schedule();
      return;
    }
    stop();
  };

  const schedule = () => {
    scheduleWatcherPoll(reviewWatchers, runId, tick, reviewPollIntervalMs(process.env.CLAWBOX_CODING_REVIEW_POLL_MS));
  };

  // The first poll is immediate: the pull request has just been opened (or a
  // fix run has just pushed), and a three-minute silence before the first word
  // about it reads as nothing happening. Immediate is also why it is tracked:
  // it runs while the settle chain that opened the pull request is finishing.
  runWatcherPoll(reviewWatchers, runId, tick);
}

/**
 * Hand one round's findings to the harness as a follow-up turn.
 *
 * "started" — a run is out and the loop is now `working`. "retry" — the box
 * could not take a run right now, and the round was NOT spent. "failed" — the
 * loop is over and has already been settled.
 *
 * HOW THE FIXES GET DONE. By resuming, wherever the session is still there:
 * the run holds the code it wrote and the reasons it wrote it that way, and a
 * fresh context has to buy all of that back in tokens to arrive somewhere
 * worse. The fallback exists because a round routinely arrives twenty minutes
 * or more after the run settled — the install check alone takes that long — and
 * a settled run's session is not always resumable by then. So the fallback is a
 * run that starts cold but is otherwise the SAME chain: the same folder and
 * worktree, so the same branch; the same project; the same provider, model and
 * effort. Which of the two happened is recorded on the loop with its reason
 * (see decideReviewFixPath), because that is the first thing anyone will want
 * to know about a round that went badly.
 *
 * Either way it is one round against the owner's `coding_agent_review_rounds`
 * budget. There is deliberately no setting for the choice: the box knows
 * whether the session is there, and the owner cannot.
 */
async function startFixRun(runId: string, snapshot: ReviewSnapshot): Promise<"started" | "retry" | "failed"> {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run?.review) return "failed";
  const review = run.review;
  const problems = reviewProblems(snapshot);
  const round = review.round + 1;

  // Only the failing checks' logs, and only when there are failing checks:
  // each one is a zip download from GitHub.
  const failedChecks = problems.failedChecks.length ? await readFailedCheckLogs(run.directory, snapshot.checks) : [];

  // Re-read: the log fetch above can take minutes, and the owner may have
  // stopped the run or the loop may have been settled under us.
  const live = loadRuns().find((r) => r.id === runId);
  if (!live?.review || live.review.state !== "polling") return "failed";

  // WHICH RECORD THE ROUND IS SEEDED FROM, decided after that re-read so it
  // cannot be a record the log fetch outlived.
  //
  // The freshest session, which after the first round is the previous round's
  // own: it already remembers the fix it just pushed and what the reviewer said
  // about it. Round one falls back to the ORIGIN — and so does a later round
  // whose previous round is no longer on the record, because the owner cleared
  // the history under the loop. That fallback is not cosmetic: `startRun`
  // refuses a `resumeRunId` it cannot find with `not_found`, which this
  // function reads as a failure of the LOOP and settles the pull request on.
  const previousRound = live.review.fixRunId
    ? loadRuns().find((r) => r.id === live.review?.fixRunId) ?? null
    : null;
  const seed = previousRound ?? live;
  const fixPath = decideReviewFixPath({
    id: seed.id,
    sessionId: seed.sessionId,
    status: seed.status,
    resumable: seed.resumable,
  });

  const task = buildReviewFeedback({
    prNumber: review.prNumber,
    url: review.url,
    branch: run.pr?.branch ?? null,
    base: review.base,
    round,
    maxRounds: review.maxRounds,
    failedChecks,
    threads: problems.threads,
    conflicting: problems.conflicting,
    changesRequested: problems.changesRequested,
    // A run starting cold is TOLD it is starting cold, and told to read the
    // diff first. The findings are the same either way; what changes is that
    // one of the two readers has never seen this branch.
    fresh: fixPath.mode === "fresh",
  });

  try {
    const fix = await startRun({
      task,
      // Named on BOTH paths: it is what carries the chain — the folder and its
      // worktree, so the branch the pull request is open from; the project; the
      // provider and the model. On the fresh path the session is the only part
      // deliberately left behind.
      resumeRunId: seed.id,
      ...(fixPath.mode === "fresh" ? { freshSession: true } : {}),
      source: live.source,
      reviewLoopOf: live.id,
      reviewRound: round,
    });
    // Written only after the spawn succeeded, so a refused start leaves the
    // loop polling with its round unspent.
    const after = loadRuns().find((r) => r.id === runId);
    if (after?.review) {
      after.review = {
        ...after.review,
        state: "working",
        round,
        fixRunId: fix.id,
        roundStartedAt: Date.now(),
        fixMode: fixPath.mode,
        fixDetail: fixPath.detail,
      };
      pushProgress(after, RUNNER_STEP.reviewRound(round, after.review.maxRounds));
      persist(true);
    }
    console.error(`[coding-agent] ${fix.id} started as review round ${round} of ${runId} (${fixPath.mode}: ${fixPath.detail})`);
    return "started";
  } catch (err) {
    const kind = err instanceof CodingAgentError ? err.kind : null;
    // "busy" is the one-run-at-a-time slot and "not_ready"/"disabled" are the
    // owner's switch and the harness — all three are about the box this
    // minute, not about this pull request, so the loop waits rather than
    // spending the owner's last round on a start that never happened.
    if (kind === "busy" || kind === "not_ready" || kind === "disabled") return "retry";
    const failed = loadRuns().find((r) => r.id === runId);
    if (failed) {
      settleReview(failed, "needs_owner", `Could not start a review round: ${err instanceof Error ? err.message : String(err)}`);
    }
    return "failed";
  }
}

/**
 * End the loop a settled ROUND belonged to, when nothing else will.
 *
 * `resumeReviewAfterFix` is the ordinary way back, and it is reached from the
 * settle path. The paths that never reach it — Stop on a paused round — come
 * here instead, or the loop waits for a run that is never coming back.
 */
function endReviewLoopFor(finished: CodingRun, detail: string): void {
  if (!finished.reviewLoopOf) return;
  const origin = loadRuns().find((r) => r.id === finished.reviewLoopOf);
  if (!origin?.review || origin.review.state !== "working") return;
  settleReview(origin, "needs_owner", detail);
}

/**
 * A review round has come home: push what it committed, then look again.
 *
 * Called from the settle path instead of the pull-request step, because a
 * review-loop turn has no pull request of its own to open.
 */
async function resumeReviewAfterFix(finished: CodingRun, ended: "stop" | "pause" | null): Promise<void> {
  const origin = loadRuns().find((r) => r.id === finished.reviewLoopOf);
  if (!origin?.review || origin.review.state !== "working") return;

  // A pause is not the end of the round: the run resumes in place and its
  // settle comes back here, the way a paused run's pull request stays
  // "opening" through it.
  if (finished.status === "paused") return;
  if (ended !== null) {
    settleReview(origin, "needs_owner", `The review round was ${ended === "pause" ? "paused" : "stopped"}, so the pull request is still open.`);
    return;
  }
  if (finished.status !== "completed") {
    settleReview(origin, "needs_owner", `A review round did not finish (${finished.status}), so the pull request is still open.`);
    return;
  }

  // Belt and braces: the round is TOLD to push, and usually does. A round that
  // committed and stopped short would otherwise leave the loop re-reading an
  // unchanged pull request until the rounds ran out.
  const branch = origin.pr?.branch;
  if (branch) {
    const pushed = await pushBranch(origin.directory, branch);
    if (!pushed.ok) console.error(`[coding-agent] ${origin.id} review round push: ${pushed.detail}`);
  }

  const current = loadRuns().find((r) => r.id === origin.id);
  if (!current?.review || current.review.state !== "working") return;
  // The round may have looked at the work again — and if it did, the body's
  // evidence block describes a state that no longer exists. Refreshed before
  // the next poll, best-effort: a pull request whose body could not be rewritten
  // is still a pull request, and this must never stop the loop.
  await refreshPrEvidence(current, finished);
  current.review = { ...current.review, state: "polling", roundStartedAt: Date.now() };
  persist(true);
  watchReviewLoop(current.id);
}

/**
 * Bring an open pull request's "What the review pass saw" block up to date with
 * whatever the latest round archived. Only that block is touched.
 */
async function refreshPrEvidence(origin: CodingRun, last: CodingRun): Promise<void> {
  const number = origin.pr?.number;
  if (typeof number !== "number") return;
  const found = visualEvidenceSection(last, origin);
  if (!found) return;
  // Only the box's own block is redacted: the rest of the body is whatever is
  // on GitHub now, a person's edits included, and is put back as it was.
  const section = redactForGitHub(found);
  try {
    const updated = await updatePullRequestBody({
      directory: origin.directory,
      number,
      rewrite: (body) => withEvidenceSection(body, section),
    });
    if (!updated.ok) console.error(`[coding-agent] ${origin.id} PR #${number} evidence not updated: ${updated.detail}`);
  } catch (err) {
    console.error(`[coding-agent] ${origin.id} PR #${number} evidence not updated:`, err instanceof Error ? err.message : err);
  }
}

/**
 * What the automatic review pass is asked to do. Fixed text, not the owner's:
 * the task is the same every time, and what varies — the work — is already in
 * the resumed session and the folder.
 */
// Bench cycle 1 (2026-09-05): two review passes reported "tests pass" for a
// suite they had not run in the pass — the claim was the earlier session's.
// So the pass runs the verification itself, first, and reports only its own.
export const REVIEW_PASS_TASK =
  "Automatic review pass. Start by running the project's own verification — its tests or build — in THIS pass"
  + " and quote the result. Then adversarially review the work you just delivered in this folder: read the diff"
  + " of your last commit (git show HEAD; if there is no commit, review the working tree), and hunt for real"
  + " defects — logic errors, broken edge cases, unsafe handling, anything that verification did not actually prove."
  + " For each defect you CONFIRM: fix it, re-run that verification, and note it in your report."
  + " Report only what you ran in this pass: a result from the earlier session is not yours to claim."
  + " Do not restyle or refactor working code, and do not invent work: if nothing real is found, say so in one"
  + " line and finish. Update report.md in your evidence folder with what you checked, found, and fixed.";

/**
 * The whole task a review pass is given: the fixed review text plus the visual
 * check this run's own diff earns.
 *
 * The two are joined HERE rather than in the constant because the second half
 * depends on what the run touched — and the decision is the device's, made from
 * the file list the runner already holds, so a pass is never left to guess
 * whether the work it is reviewing has a face (see coding-review-visual.ts).
 */
export function reviewPassTask(finished: Pick<CodingRun, "filesTouched">): string {
  return `${REVIEW_PASS_TASK}\n\n${visualCheckBrief(finished.filesTouched, previewScriptPath())}`;
}

/**
 * What became of the review pass after a run settled: a review run is now
 * working ("started"), none was due ("skipped"), or one was due and could not
 * start ("refused"). The pull request step needs the difference — it waits
 * only for a review that exists, and treats one that could not run as no
 * verdict rather than a pass.
 */
type ReviewPassOutcome = "started" | "skipped" | "refused";

/**
 * One automatic follow-up run when the owner has switched the review pass on.
 *
 * The guards make it a pass and never a loop: only after a run that COMPLETED
 * and touched files, and never after a run that is itself a review pass
 * (reviewOf set). startRun re-checks the owner's switch, readiness and the
 * one-run-at-a-time slot, so this can refuse for the same reasons any start
 * can — and a refusal is a logged line, never an error the settled run feels.
 */
async function maybeStartReviewPass(finished: CodingRun): Promise<ReviewPassOutcome> {
  if (finished.status !== "completed") return "skipped";
  if (finished.reviewOf !== null) return "skipped";
  // A review-loop turn has already had its work reviewed — by GitHub's own
  // checks and by whoever left the comments it just answered. A pass over it
  // would spend a run to review a fix to a review.
  if (finished.reviewLoopOf !== null) return "skipped";
  if (finished.readOnly) return "skipped";
  // A team's worker is reviewed by the team's own reviewer, on the merged work.
  if (finished.team) return "skipped";
  if (finished.filesTouched.length === 0) return "skipped";
  // The switch as it stood when THIS run started — the same decision its
  // brief was written from — never the switch as it stands now.
  if (!finished.reviewPass) return "skipped";
  try {
    const review = await startRun({
      task: reviewPassTask(finished),
      resumeRunId: finished.id,
      source: finished.source,
      reviewOf: finished.id,
    });
    console.error(`[coding-agent] ${review.id} started as the automatic review pass of ${finished.id}`);
    return "started";
  } catch (err) {
    console.error(`[coding-agent] review pass of ${finished.id} not started:`, err instanceof Error ? err.message : err);
    return "refused";
  }
}


// ─── Durable completion: a run is done when the deliverable exists ───────────

/**
 * The bar THIS run is held to, explicit or implied.
 *
 * The implied half is the auto-PR switch: a box with it on has already said the
 * point of a run is a pull request, so there is nothing else for a deliverable
 * to be and nothing for the owner to type. It is implied only where a pull
 * request was actually POSSIBLE, though — `pr === null` is a folder that is not
 * a repository yet, and `pr.phase === "failed"` is the box recording that its
 * own pull-request flow could not run (no remote, `gh` not logged in, the push
 * refused). Nudging the harness for a pull request the DEVICE cannot open would
 * spend every attempt on the one thing the harness cannot fix, so the implied
 * deliverable steps aside there. An EXPLICIT `{ kind: "pr" }` is honoured as
 * the caller stated it, because that is an instruction rather than an inference.
 */
function deliverableFor(run: CodingRun): Deliverable | null {
  if (run.deliverable) return run.deliverable;
  if (run.pr && run.pr.phase !== "failed") return { kind: "pr" };
  return null;
}

/**
 * Will the deliverable gate decide this run's ending, rather than the status
 * the harness just reported?
 *
 * ONE predicate, because two readers have to agree on it exactly: `finishRun`
 * holds the finish notice back when it is true (a notice saying "finished" over
 * a run about to go back in would be the lie this feature exists to remove),
 * and `enforceDeliverable` is what then sends that notice. A disagreement
 * between them is a run nobody is ever told about.
 *
 * `completed` only: every other ending is the harness's or the owner's, and a
 * deliverable has no opinion about a run that failed or was stopped. A review
 * pass, a review-loop turn, a read-only planner and a team's run are all
 * excluded for the reasons `maybeStartReviewPass` excludes them — none of them
 * is the run that owes the deliverable.
 */
function deliverableGateApplies(run: CodingRun): boolean {
  if (run.status !== "completed") return false;
  if (run.reviewOf !== null || run.reviewLoopOf !== null) return false;
  if (run.readOnly || run.team) return false;
  return deliverableFor(run) !== null;
}

/**
 * Was this run EVER held to a deliverable — whatever the answer is now?
 *
 * The question `finishRun` really asked when it held the finish notice back, and
 * the one the gate has to ask to know whether it owes that notice. It cannot
 * simply re-read `deliverableFor`, because the implied pull-request bar can step
 * aside between the two (see the branch that uses this), and it must not assume
 * an attempt is still open, because an owner Resume at the attempt ceiling opens
 * none.
 *
 * Exact, not a heuristic: a named deliverable is frozen on the record and never
 * removed, and a run that got the implied one always had `openAttempt` push an
 * entry at its start — so "no deliverable and no attempt" is precisely a run
 * that was never gated, which `finishRun` announced itself.
 */
function wasGated(run: CodingRun): boolean {
  return run.deliverable !== null || run.attempts.length > 0;
}

/** Open an attempt entry, for a run that has a deliverable to clear. */
function openAttempt(run: CodingRun): void {
  if (deliverableFor(run) === null) return;
  // Never two open at once: a record whose previous attempt was left open by a
  // restart must not grow a second one, or the count that decides "no more
  // attempts" would be the count of interruptions.
  if (run.attempts.some((a) => a.endedAt === null)) return;
  if (run.attempts.length >= MAX_COMPLETION_ATTEMPTS) return;
  run.attempts.push({ startedAt: Date.now(), endedAt: null, reason: null });
}

/**
 * Close the open attempt with what was still missing (null when it was there).
 *
 * A judgement with no open entry to close still gets recorded — a record from
 * before the field, or one whose attempt a restart closed — because the count
 * of attempts is what decides whether to try again, and a judgement that
 * vanished would let a run be nudged for ever.
 */
function closeAttempt(run: CodingRun, missing: string | null): void {
  const reason = missing ? missing.slice(0, MAX_MISSING_CHARS) : null;
  for (let i = run.attempts.length - 1; i >= 0; i -= 1) {
    if (run.attempts[i].endedAt !== null) continue;
    run.attempts[i].endedAt = Date.now();
    run.attempts[i].reason = reason;
    return;
  }
  if (run.attempts.length >= MAX_COMPLETION_ATTEMPTS) return;
  run.attempts.push({ startedAt: run.startedAt, endedAt: Date.now(), reason });
}

/**
 * The sandbox a deliverable COMMAND runs in: the harness's own.
 *
 * Null when `setpriv` cannot be found, which is the same condition that refuses
 * a run outright — the checker then reports the command as unrunnable rather
 * than running it with the web server's ambient network capabilities.
 */
async function deliverableSandbox(run: CodingRun): Promise<DeliverableSandbox | null> {
  const setprivPath = await findExecutableOnPath(CAPABILITY_DROP_COMMAND);
  if (!setprivPath) return null;
  return {
    bin: setprivPath,
    args: CAPABILITY_DROP_ARGS,
    // The run's own provider, like its harness's: never the default's wiring
    // under a run that is paid from the other account.
    env: buildRunEnv({ effort: run.effort, artifactsDir: artifactsDir(run.id), inputsDir: runInputsDir(run.id), provider: run.provider, model: run.requestedModel }),
  };
}

/**
 * The sandbox a coding team runs the project's own test suite in, on its
 * merged result (`coding-team-suite.ts`, TASK-1321): the harness's own, as for
 * a deliverable command, with a run's environment and no run behind it — plus
 * two words for a test runner: CI, so one that would watch for changes runs
 * once, and no bytecode, so the suite leaves no __pycache__ in the checkout the
 * team's next merge lands in. Null when `setpriv` cannot be found: the suite is
 * then not run at all.
 */
export async function suiteSandbox(): Promise<DeliverableSandbox | null> {
  const setprivPath = await findExecutableOnPath(CAPABILITY_DROP_COMMAND);
  if (!setprivPath) return null;
  return {
    bin: setprivPath,
    args: CAPABILITY_DROP_ARGS,
    env: { ...buildRunEnv(), CI: "1", PYTHONDONTWRITEBYTECODE: "1" },
  };
}

/**
 * Put the pull request step back to pending for a run that is going back to
 * work, when no pull request was ever opened.
 *
 * `maybeOpenPullRequest` only opens one from `phase: "opening"`, so a record
 * settled as "blocked" — which is what "Nothing was committed, so there is no
 * pull request to open" writes — would never get another go: the next attempt
 * would commit the work and no pull request would follow it, leaving the one
 * deliverable that can then never be met.
 *
 * `"failed"` is reopened for the same reason, and the case is sharper. The
 * IMPLIED bar steps aside on that phase (`deliverableFor`), so no attempt is
 * started for it at all — but an EXPLICIT `{ kind: "pr" }` is honoured as the
 * caller stated it, whatever the phase, so without this an attempt after a
 * failed pull-request flow (`gh` not logged in, the push refused, auto-PR
 * switched off mid-run) could never meet the bar no matter what the harness did:
 * every attempt spent on something unreachable, ending `gave_up` over work that
 * was done. Reopening gives the next one a real chance — a transient `gh`
 * failure, a remote added since, a run that pushes for itself — and where the
 * cause persists the ending is the same, just honestly earned.
 *
 * Only a pull request that was never OPENED is reopened either way; a real one
 * has a number and IS the thing being checked for.
 */
function reopenPullRequestStep(run: CodingRun): void {
  const reopenable = run.pr?.phase === "blocked" || run.pr?.phase === "failed";
  if (run.pr && reopenable && run.pr.number === null) {
    run.pr = { ...run.pr, phase: "opening", detail: null, endedAt: null };
  }
}

/**
 * The finish notice, once the gate has decided what this run actually is.
 *
 * Unless a DELIVERY PIPELINE is still going, which is the later authority on
 * what this run is: the deliverable being there means the build stage passed,
 * not that the work is deployed and checked. The pipeline sends the notice when
 * it settles, so the two never both send one and never both stay silent.
 */
function announceGatedRun(run: CodingRun): void {
  if (pipelineOwnsRun(run)) return;
  void announceCodingAgent(cloneRun(run)).catch((err: unknown) => {
    console.error("[coding-agent] announce failed:", err instanceof Error ? err.message : err);
  });
}

/**
 * Did the run leave the deliverable behind — and if not, what now?
 *
 * The last step of the settle chain, and the one that makes `completed` mean
 * something. Before it, a harness that spent twenty turns, concluded the task
 * was beyond it and wrote a courteous paragraph settled exactly like one that
 * built the thing: both emit a success result event, and nothing on the box had
 * looked at the folder.
 *
 * Three endings, and the ATTEMPT is the middle one: the deliverable is there
 * (`completed` stands), it is not and there are attempts left (the same record
 * goes back in, same session, with a nudge naming what is missing), or it is
 * not and there are none (`gave_up`, with the missing thing as the reason and
 * Resume as the way on).
 *
 * Never throws: it runs inside the settle chain, and a thrown error here would
 * leave a record whose notice was held back by `finishRun` and never sent.
 */
async function enforceDeliverable(finished: CodingRun, ended: "stop" | "pause" | null, review: ReviewPassOutcome): Promise<void> {
  // The chain is not over. A review pass is running in this run's own session,
  // and its settle comes back here — the same deferral `maybeOpenPullRequest`
  // makes, for the same reason: the review's commits are part of what the
  // deliverable is judged on.
  if (review === "started") return;
  // A review-loop turn's settle belongs to the loop, and the run it is fixing
  // was judged when IT settled.
  if (finished.reviewLoopOf !== null) return;
  // A paused review pass is not the end of the chain either: it resumes in
  // place and comes back here. Judging the deliverable now would judge a folder
  // a live session is still working in.
  if (finished.reviewOf !== null && finished.status === "paused") return;

  // The run that owes the deliverable: this one, or — when this is its review
  // pass — the one it reviewed. Re-read from the list, because the review run's
  // own settle is a different object.
  const originId = finished.reviewOf ?? finished.id;
  const origin = loadRuns().find((r) => r.id === originId);
  if (!origin) return;
  // The same conditions `deliverableGateApplies` reads, taken apart — because
  // the LAST of them can have changed since `finishRun` held the notice, and
  // that case needs a different answer from "this was never gated".
  if (origin.status !== "completed") return;
  if (origin.reviewOf !== null || origin.reviewLoopOf !== null) return;
  if (origin.readOnly || origin.team) return;

  const deliverable = deliverableFor(origin);
  if (!deliverable) {
    // The bar is GONE since the run settled. One way in: the deliverable was
    // the one the auto-PR switch implied, and `maybeOpenPullRequest` has just
    // recorded `pr.phase === "failed"` — the box's own flow could not run (no
    // remote, `gh` not logged in, the push refused), which the harness cannot
    // fix, so the implied deliverable steps aside rather than burn every
    // attempt on it.
    //
    // `finishRun` held this run's finish notice on the strength of the bar that
    // existed then, so it is sent HERE. A run nobody is ever told about is the
    // worse of the two failures.
    //
    // `wasGated` and not "an attempt is still open": the two agree almost
    // always, and the case where they do not is an owner Resume at the attempt
    // ceiling, where `openAttempt` declines and the notice would have been
    // swallowed. Nor is it announced unconditionally — a run that never had a
    // bar at all reaches this branch too, and `finishRun` announced that one
    // itself, so a second notice here would be a duplicate.
    if (wasGated(origin)) {
      closeAttempt(origin, null);
      persist(true);
      announceGatedRun(origin);
    }
    return;
  }

  try {
    // The owner's own gesture ends this, not the deliverable. Judging it now
    // would answer a question they have already closed, and `gave_up` over a
    // Stop would read as the box blaming the harness for obeying.
    if (ended !== null) {
      closeAttempt(origin, null);
      persist(true);
      announceGatedRun(origin);
      return;
    }

    const verdict = await checkDeliverable(
      { directory: origin.directory, pr: origin.pr },
      deliverable,
      deliverable.kind === "command" ? await deliverableSandbox(origin) : null,
    );
    origin.deliverableCheck = verdict;
    closeAttempt(origin, verdict.ok ? null : verdict.missing);

    if (verdict.ok) {
      pushProgress(origin, RUNNER_STEP.deliverableMet);
      persist(true);
      announceGatedRun(origin);
      return;
    }

    pushProgress(origin, RUNNER_STEP.deliverableMissing(verdict.missing ?? ""));
    const made = origin.attempts.length;
    if (made >= origin.completionAttempts) {
      giveUp(origin, verdict.missing ?? "", made);
      return;
    }
    await startCompletionAttempt(origin, deliverable, verdict.missing ?? "", made + 1);
  } catch (err) {
    // The check itself broke. NOT a pass: that is the whole point of the
    // feature. The run is recorded as not having got there, with what went
    // wrong as the reason, and the owner is told — which is strictly better
    // than a tick over an unanswered question.
    const reason = `The deliverable could not be checked: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[coding-agent] ${origin.id} deliverable check failed:`, err instanceof Error ? err.message : err);
    // Unless the run has ALREADY been settled by something inside the try — a
    // `giveUp` from the attempt's own gates, or the spawn failure that settles
    // the record as failed. Giving up a second time would push a second ending
    // onto the timeline, announce the run twice and add a phantom attempt to
    // the count the card shows.
    if (origin.status !== "completed") {
      persist(true);
      return;
    }
    origin.deliverableCheck = { ok: false, missing: reason.slice(0, MAX_MISSING_CHARS), checkedAt: Date.now() };
    closeAttempt(origin, reason);
    giveUp(origin, reason, origin.attempts.length);
  }
}

/**
 * The honest ending for a run that worked, said it was done, and did not leave
 * the deliverable behind.
 *
 * `resumable` is set, and that is the point of the status: the session is
 * intact — the harness finished normally, so nothing is poisoned in it the way
 * an authentication failure poisons one — and Resume carries on in it with
 * everything already done still on disk. `completedAt` is kept if it is
 * already there, so the elapsed clock still measures the work rather than the
 * gate's own moment.
 */
function giveUp(run: CodingRun, missing: string, attempts: number): void {
  run.status = "gave_up";
  run.error = gaveUpReason(missing, attempts).slice(0, MAX_ERROR_CHARS);
  run.resumable = true;
  run.completedAt = run.completedAt ?? Date.now();
  pushProgress(run, RUNNER_STEP.finished(run.status));
  persist(true);
  console.error(`[coding-agent] ${run.id} gave up after ${attempts} attempt(s) at its deliverable`);
  announceGatedRun(run);
}

/**
 * One more go at the deliverable: the SAME record, the SAME session, a nudge
 * naming what is missing.
 *
 * In place rather than as a fresh run, which is what the brief's "resume with
 * context" means and what the record needs: `attempts`, the deliverable and the
 * verdict all belong to one run, and the owner asked one question. Mechanically
 * it is `resumeRunOnce`'s spawn — `--resume` on the run's own session id with
 * the continuation on stdin — so the transcript of the attempt that just ended
 * is still in front of the harness, which is why the nudge can say "do not
 * start over" and be obeyed.
 */
async function startCompletionAttempt(
  run: CodingRun,
  deliverable: Deliverable,
  missing: string,
  attempt: number,
): Promise<void> {
  // No session means there is nothing to CARRY ON from, and this loop's whole
  // premise is that there is: the nudge says "do not start over" because the
  // transcript of the attempt that just ended is still in front of the harness.
  // Spawned without one it would be a fresh session handed a note about a
  // missing file — the task redone from nothing, charged to the owner under the
  // name of "one more attempt". So the honest ending is recorded instead.
  if (!run.sessionId) {
    giveUp(run, `${missing} There is no session to carry on in, so the box did not try again.`, run.attempts.length);
    return;
  }

  let tools: SpawnTools;
  // Held across the two awaits below and given back the moment the record is
  // live again (the flip after this block is synchronous) — see `startingRuns`.
  let releaseSlot: (() => void) | null = null;
  try {
    // The same gates a start passes — the owner's switch, readiness, the
    // slot — because this IS a start, and the owner may have switched the
    // agent off while the run worked.
    releaseSlot = await assertCanSpawn(null);
    tools = await requireSpawnTools();
    run.directory = await realDirectory(run.directory);
  } catch (err) {
    releaseSlot?.();
    // Another attempt cannot be made now. The ending is still the honest one:
    // the deliverable is not there. The reason says both halves, so the owner
    // is not left wondering why the attempts stopped short.
    const why = err instanceof Error ? err.message : String(err);
    giveUp(run, `${missing} Another attempt could not be started: ${why}`, run.attempts.length);
    return;
  }
  releaseSlot?.();

  reopenPullRequestStep(run);
  run.status = "running";
  run.completedAt = null;
  run.exitCode = null;
  run.error = null;
  run.pauseReason = null;
  // Judged again when this attempt settles; until then there is no verdict
  // about a run that is still working.
  run.leftover = false;
  run.lastActivityAt = Date.now();
  openAttempt(run);
  pushProgress(run, RUNNER_STEP.anotherAttempt(attempt, run.completionAttempts));
  // RE-RESOLVED for this attempt, like a resume's. The previous attempt's
  // settle dropped the values out of memory (cleanupRunResources), so they have
  // to be worked out again either way — and re-reading is the safer of the two
  // answers: an entry the owner un-ticked while the run was working is not
  // handed back to it, and the redaction table is armed again before the child
  // that would echo one exists.
  await prepareRunSecrets(run);
  persist(true);
  console.error(`[coding-agent] ${run.id} attempt ${attempt} of ${run.completionAttempts} at its deliverable`);
  startProjectIcon(run);
  try {
    spawnOrSettle(
      run,
      run.sessionId,
      tools,
      { effort: run.effort, maxTurns: run.maxTurns },
      completionNudge(deliverable, missing, { n: attempt, of: run.completionAttempts }),
      // The same record, continuing: its counters and its recorded refusals are
      // the run's whole history, not the last attempt's.
      true,
    );
  } catch {
    // `spawnOrSettle` has already settled the record as failed and said why, and
    // it rethrows for the benefit of a route's caller — of which there is none
    // here, so the throw itself is not news. What IS left to do is the two
    // things that path does not do: close the attempt this call opened (left
    // open it would read as a turn still being made, and would stop any later
    // Resume from opening one), and send the finish notice `finishRun` held for
    // a gate that has now ended the run on its own.
    closeAttempt(run, missing);
    persist(true);
    announceGatedRun(run);
  }
}


// ─── The delivery pipeline ───────────────────────────────────────────────────

/**
 * The DRIVER: what actually happens at each stage of src/lib/coding-pipeline.ts.
 *
 * WHY IT IS HERE AND NOT IN A MODULE OF ITS OWN. Every stage is a thing this
 * file already does — start a run in an existing session, watch a deployment,
 * settle a record, announce a run. The driver is the ORDER, and it is written
 * beside the machinery it orders for the same reason `watchReviewLoop` and
 * `watchDeployment` are: a module that had to be handed `loadRuns`, `persist`,
 * `startRun`, `pushProgress` and the live handles is a module that has the
 * wrong boundary. What it does NOT contain is the decision-making — that is the
 * pure machine, so the transitions can be walked in a unit test without a run,
 * a deployment or a browser.
 *
 * WHAT DRIVES IT. Three seams, and no timer of its own:
 *
 *  - a RUN settling (`pipelineAfterSettle`, from the end of `reviewAndShip`) —
 *    the build stage, the review stage and every improvement lap;
 *  - the OWNER pressing the production button (`approvePipelineProduction`).
 *
 * The verifications are the one thing it does itself, inline, because a fetch
 * and a screenshot are seconds rather than an event to wait for.
 */

/** One advance at a time per run: two seams can fire on the same record. */
const pipelineAdvancing = store.pipelineAdvancing;

/**
 * True while a live pipeline still owns this run — its own, or the one
 * belonging to the origin a review pass was started for.
 *
 * TWO THINGS ARE HELD ON IT, and they are the same question asked twice:
 *
 *  - THE FINISH NOTICE. The same predicate `deliverableGateApplies` is, and for
 *    the same reason: "Coding agent finished run-x" over a run that is about to
 *    deploy to production is exactly the claim the gate exists to stop making.
 *    `finishRun` holds the notice on it and the pipeline sends it when it
 *    settles, so no run falls between them.
 *  - THE RUN'S WORKTREE. `settleRunWorktree` steps aside while a run is LIVE in
 *    the tree, which a pipeline BETWEEN stages is not: a deployment is building
 *    or a verification is fetching, and nothing holds the folder. So the settle
 *    merged the copy home and deleted it while the pipeline still needed it —
 *    the improvement lap re-spawns into that very folder and the deploy uploads
 *    it. `settlePipelineRun` is what settles the tree once the chain is over.
 */
function pipelineOwnsRun(run: CodingRun): boolean {
  if (isPipelineLive(run.pipeline)) return true;
  // A turn INSIDE a pipeline's chain holds it too. The automatic review pass is
  // a run record of its own, and nobody asked for it: announcing it would put
  // "Coding agent finished run-x" on the desktop in the middle of a flow that
  // is still deploying — the same claim, about a run the owner never started.
  if (run.reviewOf) {
    const origin = loadRuns().find((r) => r.id === run.reviewOf);
    return isPipelineLive(origin?.pipeline);
  }
  return false;
}

/**
 * Queue an advance behind whatever else is advancing this run's pipeline.
 *
 * BOTH seams go through it, and that is the point: a deployment settling on its
 * watcher's timer and a run settling on its child's `close` handler are two
 * different call stacks reaching the same record, and each stage guard reads
 * `pipeline.stage` — which the other one is in the middle of moving.
 */
function queuePipelineWork(runId: string, work: () => Promise<void>): Promise<void> {
  const previous = pipelineAdvancing.get(runId) ?? Promise.resolve();
  const mine = previous.then(work, work).then(
    () => {},
    (err: unknown) => {
      console.error(`[coding-agent] pipeline for ${runId}:`, err instanceof Error ? err.message : err);
    },
  );
  pipelineAdvancing.set(runId, mine);
  // Dropped once it settles, and only when it is still the one in the map: the
  // store is process-wide and lives as long as the web server, so without this
  // every pipeline that ever ran leaves a settled promise behind.
  const forget = () => {
    if (pipelineAdvancing.get(runId) === mine) pipelineAdvancing.delete(runId);
  };
  void mine.then(forget, forget);
  return mine;
}

/** The fire-and-forget form, for a caller with nothing to wait on. */
function advancePipeline(runId: string, work: () => Promise<void>): void {
  // Held like every other settle chain, so a suite can wait for it rather than
  // remove the tree a deployment record is still being written into.
  trackSettleWork(queuePipelineWork(runId, work));
}

/**
 * Can this box run the whole pipeline at all?
 *
 * Asked ONCE, when the run starts, and not at the stage that would need it.
 * The owner's rule: a pipeline that cannot finish must say so before the box
 * spends a build, a review pass and three improvement laps getting to the
 * stage that would have proved it.
 */
export async function pipelinePreflight(
  scope: string | null,
  verify: PipelineVerify,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!scope) {
    return { ok: false, reason: "That folder is not one of this ClawBox's projects, so the pipeline has nothing to work in." };
  }
  // The other half: a verification this box could not make is not a pass, so a
  // pipeline that could only ever reach that answer is refused here instead.
  if (verify.expect.length === 0) {
    const token = await configGet("clawai_token");
    if (typeof token !== "string" || !token.trim()) {
      return {
        ok: false,
        reason: "This ClawBox has no vision model to check a deployed page with, and the pipeline was not told what to look for. Connect ClawBox AI, or name what the page must contain.",
      };
    }
  }
  return { ok: true };
}

/** The review run that has just gone out for this origin, newest first. */
function reviewRunFor(originId: string): CodingRun | null {
  return loadRuns().find((r) => r.reviewOf === originId && isLive(r.status))
    ?? loadRuns().find((r) => r.reviewOf === originId)
    ?? null;
}

/**
 * A run has settled. Close whichever stage that was, and go on.
 *
 * Called at the END of `reviewAndShip`, after the deliverable gate — because
 * the gate can put the very same record back to work, and a pipeline that
 * advanced past a run that is running again would be deploying a folder a live
 * session is still writing in.
 */
function pipelineAfterSettle(
  finished: CodingRun,
  ended: "stop" | "pause" | null,
  review: ReviewPassOutcome,
): Promise<void> {
  // AWAITED by the settle chain, unlike the deployment seam: `settleRunWorktree`
  // runs straight after and steps aside only while a run is LIVE in the tree, so
  // an improvement lap that had not been spawned yet would have its folder
  // merged home and removed out from under it.
  return queuePipelineWork(finished.reviewOf ?? finished.id, () => settlePipelineStage(finished, ended, review));
}

async function settlePipelineStage(
  finished: CodingRun,
  ended: "stop" | "pause" | null,
  review: ReviewPassOutcome,
): Promise<void> {
  const originId = finished.reviewOf ?? finished.id;
  const origin = loadRuns().find((r) => r.id === originId);
  const pipeline = origin?.pipeline;
  if (!origin || !pipeline || !isPipelineLive(pipeline)) return;

  // The owner's own gesture ends it. Judging a stage now would answer a
  // question they have already closed.
  if (ended !== null) {
    stopPipeline(pipeline, ended === "pause"
      ? "The run was paused, so the pipeline stopped here."
      : "The run was stopped, so the pipeline stopped here.");
    pushProgress(origin, RUNNER_STEP.pipelineStopped(pipeline.failure?.reason ?? "stopped"));
    persist(true);
    announcePipeline(origin);
    return;
  }
  // A pause is not the end of a stage: the run resumes in place and its settle
  // comes back here. Nor is a deliverable attempt that has just gone back in.
  if (finished.status === "paused" || origin.status === "paused" || origin.status === "running") return;

  if (pipeline.stage === "build" || pipeline.stage === "improvement") {
    // Only the ORIGIN closes these: at stage `improvement` a stray review run
    // from an earlier lap settling late must not be read as the lap's own end.
    if (finished.id !== origin.id) return;
    const outcome: StageOutcome = origin.status === "completed"
      ? { kind: "passed" }
      : { kind: "failed", reason: `The run did not finish (${origin.status}).${origin.error ? ` ${origin.error}` : ""}` };
    await applyPipelineStage(origin.id, pipeline.stage, outcome, review);
    return;
  }

  if (pipeline.stage === "review") {
    if (finished.reviewOf !== origin.id) return;
    const outcome: StageOutcome = finished.status === "completed"
      ? { kind: "passed", detail: finished.filesTouched.length ? `The review pass changed ${finished.filesTouched.length} file(s).` : "The review pass found nothing to change." }
      : { kind: "failed", reason: `The review pass did not finish (${finished.status}).${finished.error ? ` ${finished.error}` : ""}` };
    await applyPipelineStage(origin.id, "review", outcome, review);
  }
  // Every other stage is settled by a deployment or by a verification this
  // driver made itself; a run settling under one of them is a review-loop or
  // deployment-fix turn, which belongs to its own watcher.
}

/** Record what a stage did, then carry on for as long as the machine says to. */
async function applyPipelineStage(
  runId: string,
  stage: PipelineStage,
  outcome: StageOutcome,
  review?: ReviewPassOutcome,
): Promise<void> {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run?.pipeline || !isPipelineLive(run.pipeline)) return;
  const transition = decidePipeline(run.pipeline, stage, outcome);
  persist(true);
  await drivePipeline(runId, transition, review);
}

/**
 * Carry on for as long as the machine says to.
 *
 * Its own function because the owner's production button enters a stage
 * DIRECTLY rather than by re-deciding one that already passed — re-deciding
 * `verify_preview` would overwrite what the check actually found with the
 * sentence "the owner approved it", which is the one thing on that step worth
 * keeping.
 */
async function drivePipeline(
  runId: string,
  first: PipelineTransition,
  review?: ReviewPassOutcome,
): Promise<void> {
  let transition = first;
  // One consumption of the review outcome: it describes the pass that was
  // started by the settle we are in, and a later lap gets its own.
  let pendingReview = review;
  for (;;) {
    if (transition.action === "wait") return;
    if (transition.action === "settled") {
      await settlePipelineRun(runId);
      return;
    }
    const entered = transition.stage;
    const current = loadRuns().find((r) => r.id === runId);
    if (!current?.pipeline) return;
    const next = await enterPipelineStage(current, entered, pendingReview);
    pendingReview = undefined;
    persist(true);
    // The stage is under way and something else brings the pipeline back.
    if (!next) return;
    const live = loadRuns().find((r) => r.id === runId);
    if (!live?.pipeline || !isPipelineLive(live.pipeline)) return;
    transition = decidePipeline(live.pipeline, entered, next);
    persist(true);
  }
}

/**
 * Begin a stage.
 *
 * Answers `null` when the stage is now UNDER WAY and something else will bring
 * the pipeline back — a run that has to finish, a deployment that has to build
 * — and an outcome when the stage decided itself, which the two verifications
 * and every refusal do.
 */
/**
 * What a deploy-or-check stage answers on a box with no deployment
 * integration, which is every ClawBox: the four stages are SKIPPED, with the
 * reason on the step's own `detail`.
 *
 * Skipped and not failed: the pipeline's first half — build, review, improve —
 * is work the owner asked for and got, and throwing it away over a capability
 * the box does not have would be the box punishing them for it.
 */
export const PIPELINE_DEPLOY_UNAVAILABLE_DETAIL =
  "deploy_unavailable: this ClawBox has no deployment integration, so there was nothing to deploy to or check.";

async function enterPipelineStage(
  run: CodingRun,
  stage: PipelineStage,
  review?: ReviewPassOutcome,
): Promise<StageOutcome | null> {
  const pipeline = run.pipeline;
  if (!pipeline) return null;
  enterStage(pipeline, stage);

  switch (stage) {
    case "build":
      // Never entered from a transition: the build IS the run, and it is
      // already going when the pipeline is made.
      return null;

    case "review": {
      if (review === "started") {
        const reviewRun = reviewRunFor(run.id);
        addEvidence(pipeline, "review", {
          kind: "run",
          ref: reviewRun?.id ?? null,
          detail: "An automatic review pass is reading the work.",
        });
        pushProgress(run, RUNNER_STEP.pipelineReview);
        persist(true);
        return null;
      }
      if (review === "refused") {
        return { kind: "failed", reason: "The automatic review pass was due and could not be started." };
      }
      // "skipped", and the same answer for a lap that somehow reached this
      // stage with no outcome to read: nothing was reviewed, and saying it
      // PASSED would be the box claiming work it did not do.
      return { kind: "skipped", detail: "There was nothing for the review pass to read, so it did not run." };
    }

    case "improvement":
      return startPipelineImprovement(run);

    // ALL FOUR, not just the two deploys: `skipped` advances to the next stage
    // (decidePipeline), so skipping `deploy_preview` alone would walk straight
    // into `verify_preview`, which has no address to look at.
    case "deploy_preview":
    case "deploy_production":
    case "verify_preview":
    case "verify_production":
      return { kind: "skipped", detail: PIPELINE_DEPLOY_UNAVAILABLE_DETAIL };

    case "complete":
      return null;
  }
}

/**
 * Send the work back in for another lap, in the SAME record and the SAME
 * session.
 *
 * `startCompletionAttempt`'s shape, and for its reasons: the owner asked one
 * question, `attempts` and the deliverable belong to one run, and the nudge can
 * say "do not start over" and be obeyed only because the transcript of the lap
 * that just ended is still in front of the harness.
 */
async function startPipelineImprovement(run: CodingRun): Promise<StageOutcome | null> {
  const pipeline = run.pipeline;
  if (!pipeline) return null;
  if (!run.sessionId) {
    return { kind: "failed", reason: "There is no session to carry on in, so the work could not be sent back for improvement." };
  }

  // The stage the MACHINE recorded when it routed here, never a search through
  // `steps` for a failed one: see `PipelineState.sentBackFrom` for the two ways
  // that guess was wrong.
  const sentBack = pipeline.sentBackFrom;
  const stage = sentBack?.stage ?? "verify_preview";
  const reason = sentBack?.reason ?? "The delivery pipeline sent the work back.";
  const task = improvementNudge({
    stage,
    reason,
    round: pipeline.round,
    maxRounds: pipeline.maxRounds,
    buildLog: null,
    // Only when THIS lap was sent back by a verification: `lastVerification`
    // survives a lap, so after a failed deploy the one on the record belongs to
    // an earlier check, and handing it over as "what this ClawBox checked"
    // would be a lie about the work in front of the harness now.
    verification: stage === "verify_preview" || stage === "verify_production"
      ? lastVerificationFor(pipeline)
      : null,
  });

  let tools: SpawnTools;
  let releaseSlot: (() => void) | null = null;
  try {
    releaseSlot = await assertCanSpawn(null);
    tools = await requireSpawnTools();
    // The copy of the project this lap works in. A live pipeline holds it now
    // (`settleRunWorktree` steps aside for one), but a pipeline already in
    // flight when that hold shipped, or a tree the weekly sweep took, has none
    // — and the lap would die on a missing folder with the whole task still to
    // do. Put back from its branch exactly as the owner's own Resume does; a
    // restore that fails leaves the record alone and `realDirectory` below says
    // the sentence the owner needs.
    if (run.worktree) run.worktree = await reopenWorktree(run);
    run.directory = await realDirectory(run.directory);
    // Nobody else may be working in this folder. A pipelined run can ALSO have
    // the pull-request review loop going — GitHub's checks are a different
    // question from the pipeline's own — and that loop's fix turns resume the
    // same session in the same tree. Two harnesses there edit each other's
    // half-written files and each settle's `git add -A` commits the other's,
    // which is the whole reason a run gets a copy of the project to itself.
    assertDirectoryFree(run.directory, run.id);
  } catch (err) {
    releaseSlot?.();
    return { kind: "failed", reason: `Another turn could not be started: ${err instanceof Error ? err.message : String(err)}` };
  }
  releaseSlot?.();

  run.status = "running";
  run.completedAt = null;
  run.exitCode = null;
  run.error = null;
  run.pauseReason = null;
  run.leftover = false;
  run.lastActivityAt = Date.now();
  addEvidence(pipeline, "improvement", {
    kind: "note",
    ref: null,
    detail: `Round ${pipeline.round} of ${pipeline.maxRounds}: ${reason}`,
  });
  pushProgress(run, RUNNER_STEP.pipelineImprovement(pipeline.round, pipeline.maxRounds));
  // Re-resolved for this lap, like a resume's: an entry the owner un-ticked
  // while the run worked is not handed back to it, and the redaction table is
  // armed again before the child that would echo one exists.
  await prepareRunSecrets(run);
  persist(true);
  startProjectIcon(run);
  try {
    spawnOrSettle(run, run.sessionId, tools, { effort: run.effort, maxTurns: run.maxTurns }, task, true);
  } catch {
    // `spawnOrSettle` has already settled the record as failed and said why.
    return { kind: "failed", reason: "The improvement turn could not be spawned." };
  }
  return null;
}

/** What the last verification actually saw, for the nudge. */
function lastVerificationFor(pipeline: PipelineState): {
  url: string;
  status: number | null;
  missing: string[];
  description: string | null;
} | null {
  const verification = pipeline.lastVerification;
  if (!verification) return null;
  return {
    url: verification.url,
    status: verification.status,
    missing: verification.expectations.filter((e) => !e.found).map((e) => e.text),
    description: verification.vision?.description ?? null,
  };
}

/** The pipeline is over. Say what the run actually is, and tell the owner. */
async function settlePipelineRun(runId: string): Promise<void> {
  const run = loadRuns().find((r) => r.id === runId);
  const pipeline = run?.pipeline;
  if (!run || !pipeline) return;
  if (pipeline.status === "complete") {
    pushProgress(run, RUNNER_STEP.pipelineComplete);
  } else {
    pushProgress(run, RUNNER_STEP.pipelineStopped(pipeline.failure?.reason ?? pipeline.status));
    // The brief's own rule: a pipeline that did not finish ends the run
    // `gave_up`, naming the stage and the reason. Only from `completed` —
    // a run that FAILED already has the honest ending, and overwriting it
    // would hide what actually went wrong with a gentler word.
    if (run.status === "completed") {
      run.status = "gave_up";
      run.resumable = true;
      run.completedAt = run.completedAt ?? Date.now();
      run.error = pipelineGaveUpReason(pipeline).slice(0, MAX_ERROR_CHARS);
      pushProgress(run, RUNNER_STEP.finished(run.status));
    }
  }
  persist(true);
  console.error(`[coding-agent] ${run.id} pipeline ${pipeline.status} at the ${stageNoun(pipeline.stage)} stage`);
  // The copy of the project the pipeline was holding. `settleRunWorktree`
  // stepped aside for every stage, and `reviewAndShip`'s own call to it
  // returned several stages ago — on the asynchronous paths (a deployment
  // settling on its watcher, a verification this driver made itself) this is
  // the last act of the chain, so it is where the tree is decided. Idempotent:
  // on the synchronous paths `reviewAndShip` reaches it straight afterwards and
  // finds the record already settled.
  await settleRunWorktree(run);
  announcePipeline(run);
}

/** One sentence naming the stage and what stopped there. */
function pipelineGaveUpReason(pipeline: PipelineState): string {
  const reason = pipeline.failure?.reason ?? "The delivery pipeline did not finish.";
  return `The delivery pipeline stopped at the ${stageNoun(pipeline.failure?.stage ?? pipeline.stage)} stage. ${reason} Resume it to carry on in the same session.`;
}

/** The finish notice `finishRun` held back while the pipeline was still going. */
function announcePipeline(run: CodingRun): void {
  void announceCodingAgent(cloneRun(run)).catch((err: unknown) => {
    console.error("[coding-agent] announce failed:", err instanceof Error ? err.message : err);
  });
}

/**
 * The owner has pressed "Deploy to production" on a pipeline that was waiting
 * for them.
 *
 * The route holds the gate — their session, this box's own origin, an explicit
 * confirmation — and this is what happens after it. `waiting_owner` is the one
 * state that resumes on an act rather than on an event, which is why it is a
 * verb of its own rather than something a poll notices.
 */
export async function approvePipelineProduction(runId: string): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run) throw new CodingAgentError("not_found", "There is no run with that id on this ClawBox.");
  const pipeline = run.pipeline;
  if (!pipeline) throw new CodingAgentError("invalid", "That run has no delivery pipeline.");
  if (pipeline.status !== "waiting_owner") {
    throw new CodingAgentError("invalid", `That pipeline is not waiting for you: it is ${pipeline.status}.`);
  }
  // The wall clock, BEFORE anything is deployed. `decidePipeline` checks it at
  // the next transition, which for this path is after `runDeployment` has
  // already put a build on the project's own domain — so a pipeline parked
  // overnight past its budget would have shipped and then recorded that it had
  // run out of time. Asked here instead, where the answer is still "no".
  if (Date.now() > pipeline.deadlineAt) {
    const transition = decidePipeline(pipeline, "deploy_production", { kind: "passed" });
    persist(true);
    if (transition.action === "settled") await settlePipelineRun(runId);
    throw new CodingAgentError("invalid", pipeline.failure?.reason
      ?? "That pipeline ran out of its time budget while it was waiting. Start a new run.");
  }
  pipeline.status = "running";
  // Recorded, because `resumePipelines` re-enters this stage after a restart
  // and would otherwise ask the per-project switch again and park a second
  // time in front of an owner who has already pressed the button.
  pipeline.productionApprovedAt = Date.now();
  const step = stepFor(pipeline, "deploy_production");
  step.state = "pending";
  step.detail = null;
  addEvidence(pipeline, "deploy_production", {
    kind: "note",
    ref: null,
    detail: "The owner approved the production deployment.",
  });
  persist(true);
  await drivePipeline(runId, { action: "enter", stage: "deploy_production" });
  return getRun(runId) ?? cloneRun(run);
}

/**
 * The owner has told a pipeline to stop.
 *
 * Its own verb, and not something `stopRun` covers, because the state it is
 * most often used in is a pipeline WAITING for the production button: the run
 * itself settled hours ago, so `stopRun` answers it untouched and the pipeline
 * would wait for ever.
 */
export function stopRunPipeline(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no run with that id on this ClawBox.");
  if (!run.pipeline) throw new CodingAgentError("invalid", "That run has no delivery pipeline.");
  if (!isPipelineLive(run.pipeline)) return cloneRun(run);
  stopPipelineFor(run, "The owner stopped the delivery pipeline.");
  // The run's own ending stands: it built what it built, and the owner calling
  // the rest of the flow off is not the run failing.
  announcePipeline(run);
  return cloneRun(run);
}

/** Stop a live pipeline because the run it belongs to was ended. */
function stopPipelineFor(run: CodingRun, reason: string): void {
  if (!isPipelineLive(run.pipeline) || !run.pipeline) return;
  stopPipeline(run.pipeline, reason);
  pushProgress(run, RUNNER_STEP.pipelineStopped(reason));
  persist(true);
}

/**
 * Pipelines the restart interrupted.
 *
 * It deliberately does LESS than one
 * might expect, because most of the work is already done by the time it runs:
 *
 *  - a stage waiting on a RUN self-heals — `reconcileAfterRestart` reattaches or
 *    settles the record, and that settle comes back through
 *    `pipelineAfterSettle` exactly as it would have without the restart;
 *  - `waiting_owner` is not waiting on this box at all.
 *
 * What is left is the two cases nothing else covers: a VERIFICATION that was in
 * flight (a fetch and a screenshot, which nothing persisted and which is safe to
 * simply make again), and a stage recorded as running with nothing at all
 * behind it — which is what a restart between "enter the stage" and "start the
 * work" leaves, and which would otherwise be pending for ever.
 */
export function resumePipelines(): void {
  for (const run of loadRuns()) {
    const pipeline = run.pipeline;
    if (!pipeline || !isPipelineLive(pipeline)) continue;
    const stage = pipeline.stage;
    const step = stepFor(pipeline, stage);

    if (stage === "verify_preview" || stage === "verify_production") {
      if (step.state !== "running") continue;
      pushProgress(run, RUNNER_STEP.pipelineResumed);
      persist(true);
      // Re-entered rather than continued: a verification is a fetch and a
      // picture, and making it again is cheaper and more honest than guessing
      // what the last one would have said.
      advancePipeline(run.id, async () => {
        const current = loadRuns().find((r) => r.id === run.id);
        if (!current?.pipeline || !isPipelineLive(current.pipeline)) return;
        // Through the same door a fresh entry uses, so the attempt is COUNTED:
        // a box crash-looping mid-verification would otherwise re-fetch and
        // re-photograph for ever, bounded only by the wall clock.
        const outcome = await enterPipelineStage(current, stage);
        persist(true);
        if (outcome) await applyPipelineStage(run.id, stage, outcome);
      });
      continue;
    }

    if (stage === "deploy_preview" || stage === "deploy_production") {
      // Nothing deploys on this box, so the stage only has to be entered again
      // to record the skip it never got to write.
      if (step.state !== "running") continue;
      advancePipeline(run.id, async () => {
        const current = loadRuns().find((r) => r.id === run.id);
        if (!current?.pipeline || !isPipelineLive(current.pipeline)) return;
        const outcome = await enterPipelineStage(current, stage);
        persist(true);
        if (outcome) await applyPipelineStage(run.id, stage, outcome);
      });
      continue;
    }

    // build / review / improvement: a live run brings the pipeline back on its
    // own. Nothing live means the record was settled by the reconciliation,
    // whose settle chain has already been through `pipelineAfterSettle`, so
    // there is nothing left for this to do either.
  }
}

/**
 * What the CLI prints when `--effort ultracode` cannot be honoured — the two
 * messages the installed binary carries for it (dynamic workflows disabled;
 * xhigh restricted by the organisation).
 */
const ULTRACODE_REFUSED = /Ultracode needs dynamic workflows|Ultracode runs at xhigh effort, which is restricted/i;

/** The wrapper's own diagnostics, minus its start-up banner. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^claude-ds: ClawBox AI \(/.test(l));
  return lines.slice(-4).join(" ").slice(0, MAX_ERROR_CHARS);
}

/**
 * What a settled run is still doing after it has been reported finished: the
 * commit, the review decision, the pull request. finishRun cannot await any of
 * it — it is called from the child's `close` handler — so the work is started
 * and forgotten, and nothing could wait for it or even see that it was still
 * going.
 *
 * On the box that is right: the web server outlives every run. In a suite it
 * is not: the temp tree a test built is removed the moment the test returns,
 * and CI failed three times (PRs #639, #643 and #648, none of them touching
 * this code) with `ENOTEMPTY: directory not empty, rmdir '.../site/.git'` —
 * a `git init` from this path still creating .git inside the tree the teardown
 * was removing. Holding the promises costs nothing in production and gives the
 * suites something to wait on.
 *
 * The watchers the settle path arms belong here too, poll by poll: they are the
 * same "still doing after it was reported finished", only on a timer — see
 * `runWatcherPoll`.
 */
const settling = store.settling;

function trackSettleWork(work: Promise<unknown>): void {
  // Neutralised first: the tracked promise must never be the one that rejects,
  // or a caller that does not wait for it turns into an unhandled rejection.
  // The arm still says so, because `void`ing this at least surfaced a future
  // regression as one, and silence would be the strictly worse trade.
  const done = work.then(() => undefined, (err: unknown) => {
    console.error("[coding-agent] the settle path failed:", err instanceof Error ? err.message : err);
  });
  settling.add(done);
  void done.finally(() => settling.delete(done));
}

/** A plain wait. NOT `unref`ed: the point of this path is that a caller can
 *  wait for it, and an unref'd timer cannot keep the loop alive to do that. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `work`, or `ms`, whichever is first — with the timer always cleared, so a
 *  drain that finished early does not hold the loop open to its deadline. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the settle path above is finished with the disk.
 *
 * `killed` is the children the caller has just signalled. They matter because
 * a killed run registers its settle work from finishRun, which runs from the
 * child's own handler — so an empty `settling` at the moment of asking is not
 * evidence of anything until those children are gone AND the grace above has
 * passed. Measured on a loaded box, looking for a quiet turn of the event loop
 * instead missed the settle 6 times in 25.
 *
 * What the grace is: a BOUND on how late that handler may be, not a barrier.
 * `reaped()` is exact — the child object really has exited — and the settle
 * that follows arrives either from `close` (sub-millisecond) or from the
 * 250 ms `exit` timer when a grandchild holds the pipes, so 400 ms carries
 * ~150 ms of margin. A settle later than that would leave through the success
 * path in silence. Removing the window entirely means registering a
 * placeholder in `settling` synchronously at kill time; measured under 12 CPU
 * hogs it never opened (6/6 runs green), and `maxRetries` on the removal is
 * the backstop for what a bounded drain cannot promise.
 *
 * Bounded, because this is called from a teardown, and it says so when the
 * budget runs out with work still outstanding rather than reporting the same
 * success either way.
 */
async function settleWork(killed: ChildProcess[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  // `!== null` on purpose, both clauses. On a real ChildProcess the fields are
  // `number | null` and `string | null`, so the test is exact. A hand-rolled
  // stand-in — the spawn-failure suite's EventEmitter child — has NEITHER
  // field, and `undefined !== null` counts it as reaped at once, which is the
  // right answer: there is no process to wait for. `!= null` would say the
  // opposite (`undefined != null` is false) and hold every such teardown to
  // the full budget before reporting a give-up over nothing.
  const reaped = () => killed.every((child) => child.exitCode !== null || child.signalCode !== null);
  let grace = killed.length > 0;
  while (left() > 0) {
    if (settling.size > 0) {
      await within(Promise.allSettled([...settling]), left());
      continue;
    }
    if (!reaped()) {
      await wait(Math.min(REAP_POLL_MS, left()));
      continue;
    }
    if (!grace) return;
    grace = false;
    await wait(Math.min(CHILD_SETTLE_GRACE_MS, left()));
  }
  console.error(
    `[coding-agent] the settle path was still going after ${timeoutMs}ms (${settling.size} outstanding) — what it was writing may be unfinished`,
  );
}

/** The shape of the ClawBox AI proxy's allowance refusal as a harness relays it. */
const PROXY_REFUSAL_RE = /\b429\b|\busage_limit\b/;

// ─── An Anthropic account at its usage limit (TASK-902) ─────────────────────

/** A limit found on a settling run: what it is, when it lifts, and the words it came in. */
interface FoundAccountLimit {
  limit: AnthropicLimit;
  /** When the account is taken to be back: the parsed reset, else the default window. */
  until: number;
  text: string;
}

/**
 * Did this run end on its Anthropic account's usage cap?
 *
 * The harness's OWN words first — the synthetic message the CLI writes in
 * place of an answer (LiveRun.limitSignal) — and only then the head of the
 * failure the record carries, which for a run that died on a limit is that same
 * line. Never the run's transcript: a run working on this very feature fails
 * with sentences about limits in it, and those are the run's, not Anthropic's.
 */
function anthropicLimitOf(run: CodingRun, state: LiveRun): FoundAccountLimit | null {
  const now = Date.now();
  for (const text of [state.limitSignal, run.error]) {
    if (!text) continue;
    const limit = detectAnthropicLimit(text, now);
    if (limit) return { limit, until: limitUntil(limit, now), text: text.trim().slice(0, 400) };
  }
  // A synthetic message the CLI TAGGED as a rate limit is one, whatever its
  // wording: the tag is the harness saying so.
  if (state.limitSignal) {
    const limit: AnthropicLimit = { kind: "rate", resetsAt: null };
    return { limit, until: limitUntil(limit, now), text: state.limitSignal };
  }
  return null;
}

/**
 * When the FIRST account is expected back, counting the one that has just
 * refused as back at `until` — what a run waiting for "all limited" to end is
 * told. Off the snapshot, because the settle path that asks is synchronous.
 */
function earliestAccountReset(refusedId: string | null, until: number): number {
  const now = Date.now();
  let earliest = until;
  for (const account of accountsSnapshot() ?? []) {
    if (account.id === refusedId || account.status !== "limited" || account.limitedUntil === null) continue;
    if (account.limitedUntil > now && account.limitedUntil < earliest) earliest = account.limitedUntil;
  }
  return earliest;
}

/**
 * Record the limit on the account the run was on. Never throws: the run has
 * settled either way, and the pool is the owner's list, not the run's outcome.
 *
 * The notices are NOT sent from here any more (TASK-1260): recording the limit
 * moves the box's active account, and src/lib/anthropic-swap.ts announces the
 * move once — with this run's id — whichever consumer saw the limit first.
 */
async function recordAccountLimit(run: CodingRun, found: FoundAccountLimit): Promise<LimitRecorded | null> {
  if (!run.anthropicAccount) return null;
  try {
    const recorded = await markLimited(run.anthropicAccount, found.until, found.limit.kind, { source: "coding", runId: run.id });
    console.error(`[coding-agent] ${run.id}: Anthropic account ${run.anthropicAccount} hit its ${found.limit.kind} limit until ${new Date(found.until).toISOString()}${recorded.health.allLimited ? " — no account left that can answer" : ""}`);
    return recorded;
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: could not record the Anthropic account's limit:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Did the harness say Anthropic refused the account's credential (TASK-1260)?
 * Its own tagged line first, then the head of the failure — never the
 * transcript, for the reason `anthropicLimitOf` gives.
 */
function anthropicAuthFailureOf(run: CodingRun, state: LiveRun): string | null {
  for (const text of [state.authSignal, run.error]) {
    if (text && detectAnthropicAuthFailure(text)) return text.trim().slice(0, 400);
  }
  return state.authSignal;
}

/**
 * How many times one run may be carried on because its credential was
 * refused. A 401 the probe cannot pin on the account (Anthropic unreachable, a
 * CLI that refuses a working token) must not bounce a run round the pool — or
 * back onto the same account — for ever.
 */
const MAX_AUTH_SWITCHES = 3;

/** Why a run is being carried on on another account (TASK-1260 adds the last two). */
type AccountTrouble =
  | { kind: "limit"; found: FoundAccountLimit }
  | { kind: "auth"; text: string }
  | { kind: "moved" };

/** What a session resumed on another account is told. It already holds the task. */
function accountSwitchContinuation(run: CodingRun, why: AccountTrouble["kind"] = "limit"): string {
  const cause = why === "auth"
    ? "Anthropic refused the credential of the account this run was using"
    : why === "moved"
      ? "ClawBox moved every Claude consumer on the box to another Anthropic account, because the one this run was using can no longer answer"
      : "the Anthropic account this run was using reached its usage limit";
  return `Your previous turn was cut off because ${cause}.`
    + " ClawBox has moved the run to another Anthropic account; the session, the folder, the branch and everything you have done are unchanged."
    + ` Continue the task exactly where the transcript leaves off — do not start over and do not repeat work that is already done. Your evidence folder is ${artifactsDir(run.id)}.`;
}

/**
 * Move a run whose account can no longer answer — at its limit, its credential
 * refused, or taken out by a swap another consumer caused — to the box's active
 * account and resume it in place; or, when no account can take it, settle it
 * as waiting (a reset is coming) or as failed (every account needs the owner).
 *
 * Tracked settle work, run straight after `finishRun` returned with the record
 * back on "running". It re-checks that before it spawns: the owner may have
 * stopped or paused the run in between, and their gesture — which found a
 * record with no process and settled it — wins.
 */
async function continueOnAnotherAccount(
  run: CodingRun,
  state: LiveRun,
  exitCode: number | null,
  why: AccountTrouble,
  carriedSecrets: Record<string, string> | undefined,
  carriedAccount: RunAnthropicCredential | undefined,
  carriedMcp: RunMcpPlan | undefined,
): Promise<void> {
  const fromId = run.anthropicAccount;
  const fromLabel = carriedAccount?.label ?? accountsSnapshot()?.find((a) => a.id === fromId)?.label ?? null;
  const exclude = new Set<string>();
  let recorded: LimitRecorded | null = null;
  // What asking Anthropic about a refused credential answered, when it was asked.
  let authVerdict: "ok" | "dead" | "unknown" | null = null;
  if (why.kind === "limit") {
    recorded = await recordAccountLimit(run, why.found);
    if (fromId) exclude.add(fromId);
  } else if (why.kind === "auth" && fromId) {
    // Confirmed before the account is taken out: a grant the pool can still
    // renew was only stale in this process, and the run goes on on the SAME
    // account with a fresh token. A dead one is marked (which moves the box's
    // active account); one Anthropic could not be asked about sits this spawn out.
    // An account its organisation switched off is not asked about: its grant
    // renews fine, so the probe would keep it and put the run straight back on it.
    const disabled = detectAnthropicAccountDisabled(why.text);
    const verdict = disabled
      ? await markCredentialProblem(fromId, "revoked", { source: "coding", runId: run.id }).then(() => "dead" as const, () => "unknown" as const)
      : await probeAccountCredential(fromId, verifyAnthropicKey, { source: "coding", runId: run.id }).catch(() => "unknown" as const);
    console.error(`[coding-agent] ${run.id}: Anthropic refused account ${fromId}'s credential; ${disabled ? "its organization switched it off, so" : "asked again,"} it is ${verdict}`);
    authVerdict = verdict;
    if (verdict !== "ok") exclude.add(fromId);
  }
  let prepared: PreparedAccount | null = null;
  let nextResetAt: number | null = recorded?.health.nextResetAt ?? null;
  // Could another account than the one(s) just left behind answer, as far as
  // the pool knows? Null when the pool could not be read at all.
  let otherAccountOk: boolean | null = null;
  try {
    const answer = await prepareAccount({ exclude });
    prepared = answer.prepared;
    nextResetAt = answer.health.nextResetAt ?? nextResetAt;
    const now = Date.now();
    otherAccountOk = (accountsSnapshot() ?? []).some((a) => !exclude.has(a.id) && isUsable(a, now));
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: the Anthropic account pool could not be read:`, err instanceof Error ? err.message : err);
  }
  if (run.status !== "running" || live.has(run.id)) return;

  if (!prepared) {
    // Nobody else can answer after all (the next account's credential turned
    // out dead, or could not be renewed just now). Wait for the first reset,
    // settled through finishRun's ordinary tail as the pause it is — or, when
    // no account comes back by itself, fail with the one thing that helps.
    const resetsAt = nextResetAt ?? (why.kind === "limit" ? why.found.until : null);
    if (resetsAt === null) {
      // Another account that can answer is still on the list: its sign-in only
      // could not be renewed (or read) just now, which marks nothing — so
      // "refused, sign in again" would be false while the card shows it fine.
      // A failed run cannot be resumed in place (resumeRun takes a paused or
      // gave-up one), so the way out is a new start, never "resume".
      state.forcedAccountFailure = otherAccountOk === null
        ? "The Anthropic account list could not be read, so the run could not be moved to another account. Start the run again in a moment."
        : otherAccountOk
          ? "Another Anthropic account could take this run over, but its sign-in could not be renewed or read just now; the box may be offline."
            + " Start the run again once the box is back online."
          : authVerdict === "unknown"
            // Refused in the run, and asking again got no answer — its grant may well be fine.
            ? "Anthropic refused the credential this run was using, and it could not be checked again just now."
              + " If the account was signed out, sign it in again in Settings → Providers → Anthropic accounts; then start the run again."
            : "Anthropic refused the credential of every account this run could use."
              + " Sign one in again in Settings → Providers → Anthropic accounts, then start the run again.";
      finishRun(run, state, exitCode);
      return;
    }
    pushProgress(run, RUNNER_STEP.accountsWaiting(formatResetClock(resetsAt)));
    const message = why.kind === "limit" ? why.found.text : why.kind === "auth" ? why.text : "Every Anthropic account on this ClawBox is at its usage limit.";
    state.forcedAccountPause = { resetsAt: new Date(resetsAt).toISOString(), message: message.slice(0, MAX_PAUSE_MESSAGE_CHARS) };
    finishRun(run, state, exitCode);
    return;
  }

  const sameAccount = prepared.account.id === fromId;
  if (!sameAccount) {
    const switched: AccountSwitch = {
      at: Date.now(),
      fromId,
      fromLabel,
      toId: prepared.account.id,
      toLabel: prepared.account.label,
      limitedUntil: why.kind === "limit" ? why.found.until : null,
      kind: why.kind === "limit" ? why.found.limit.kind : why.kind,
    };
    run.accountSwitches = [...run.accountSwitches, switched].slice(-MAX_ACCOUNT_SWITCHES);
  }
  run.anthropicAccount = prepared.account.id;
  // Carried on, as the move is the same run's next try — but never past a
  // copy's last day, which may have gone by while this run waited for an account.
  const carried = carriedSecrets ? await withoutExpiredSecrets(carriedSecrets, runSecretScopes.get(run.id) ?? {}) : {};
  restoreRunSecrets(run.id, carried, {
    accountId: prepared.account.id,
    label: prepared.account.label,
    credential: prepared.credential,
  }, carriedMcp);
  const from = fromLabel ?? "the previous account";
  if (why.kind === "limit") pushProgress(run, RUNNER_STEP.accountSwitched(from, prepared.account.label, formatResetClock(why.found.until)));
  else if (why.kind === "auth") pushProgress(run, RUNNER_STEP.accountRefused(from, prepared.account.label));
  else pushProgress(run, RUNNER_STEP.accountMoved(from, prepared.account.label));
  persist(true);
  console.error(`[coding-agent] ${run.id}: continuing on Anthropic account ${prepared.account.id} after ${fromId ?? "its account"} ${why.kind === "limit" ? `hit its ${why.found.limit.kind} limit` : why.kind === "auth" ? "was refused" : "was swapped out"}`);
  try {
    // The SAME record and session: `continuingRecord`, so the counters add up,
    // and the session's own transcript is where the work is — the task is not
    // replayed into it. A run that never got a session starts it from the task.
    spawnOrSettle(run, run.sessionId, state.tools, state.settings, run.sessionId ? accountSwitchContinuation(run, why.kind) : undefined, true);
  } catch {
    // spawnOrSettle settled the record and said why.
  }
}

/**
 * THE CODING RUNS' HALF OF A SWAP (TASK-1260): every live run on an account
 * that can no longer answer — limited, refused, removed — is ended and carried
 * on in its own session on the active account (`accountMove`, then the same
 * continuation a limit takes), and every run waiting for a reset is resumed.
 * Review passes and team workers are runs like any other; queued runs need
 * nothing, since each spawn asks the pool for the active account.
 *
 * A run on an account that CAN still answer is left alone even when the active
 * account moved (the owner's new order, "back to the first account"): it would
 * lose its turn in flight for nothing, and its next spawn takes the new one.
 */
function moveRunsOffDeadAccounts(): string[] {
  const accounts = accountsSnapshot() ?? [];
  const now = Date.now();
  const moved: string[] = [];
  for (const run of loadRuns()) {
    if (run.status !== "running" || run.provider !== "anthropic" || !run.anthropicAccount) continue;
    const account = accounts.find((a) => a.id === run.anthropicAccount);
    if (account && isUsable(account, now)) continue;
    const state = live.get(run.id);
    if (!state || state.endRequested !== null || state.accountMove || state.simulatedLimit) continue;
    state.accountMove = true;
    endProcess(state);
    moved.push(run.id);
  }
  return moved;
}

async function applyCodingSwap(ctx: SwapContext): Promise<SwapConsumerOutcome> {
  if (!activeAccountSnapshot()) return { status: "skipped", code: "no_account", count: null };
  const moved = moveRunsOffDeadAccounts();
  const resumed = await resumeRunsWaitingForAnthropic();
  // The run whose own limit or refusal moved the account is being carried on
  // by its own path (continueOnAnotherAccount), which recorded the limit
  // first: its process is already gone, so the sweep above cannot see it. It
  // moved all the same — counted, or the card and the notice say "nothing to
  // move" over a run that just moved (2026-10-14).
  const own = ctx.change.runId;
  const ownRun = own && !moved.includes(own) && !resumed.includes(own) ? loadRuns().find((r) => r.id === own) : undefined;
  const carried = ownRun && ownRun.status === "running" && ownRun.provider === "anthropic" ? 1 : 0;
  const count = moved.length + resumed.length + carried;
  if (count > 0) console.error(`[coding-agent] the Anthropic account swap moved ${moved.length + carried} run(s) and resumed ${resumed.length}`);
  return { status: "ok", code: count > 0 ? "moved" : "nothing_running", count };
}

/** Register the runs as a consumer of the box's active account. Idempotent, per process. */
function armCodingSwapConsumer(): void {
  if (store.swapConsumerArmed) return;
  store.swapConsumerArmed = true;
  registerSwapConsumer({ name: "coding", apply: applyCodingSwap });
}

/**
 * THE TEST HOOK the acceptance run uses (TASK-902): make every live run on
 * `accountId` end as if Anthropic had refused it with a session limit, so the
 * real switch path runs — nothing about the switch itself is simulated. The
 * owner-only route is the one caller. Answers the runs it interrupted.
 */
export function simulateAnthropicLimit(accountId: string, resetsAt: number): string[] {
  const message = `You've hit your session limit · resets ${formatCliClock(resetsAt)}`;
  const interrupted: string[] = [];
  for (const run of loadRuns()) {
    if (run.status !== "running" || run.provider !== "anthropic" || run.anthropicAccount !== accountId) continue;
    const state = live.get(run.id);
    if (!state || state.endRequested !== null) continue;
    state.simulatedLimit = message;
    endProcess(state);
    interrupted.push(run.id);
  }
  return interrupted;
}

/** "10:50pm" in the box's zone — the way the CLI words a reset, so the test hook's line is parsed like a real one. */
function formatCliClock(at: number): string {
  const [h, m] = formatResetClock(at).split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/**
 * Resume every run that is waiting for an Anthropic limit to reset — the wake
 * the pool fires at the first reset (onLimitReset), and the boot hook.
 *
 * Oldest wait first, one at a time, through the ordinary resume gates: a run
 * the one-run-at-a-time rule turns away stays waiting, and the next wake (or a
 * finishing run's own settle) tries again. A run that nobody could resume
 * because the pool is still limited stays exactly as it was.
 */
export async function resumeRunsWaitingForAnthropic(): Promise<string[]> {
  // One pass at a time: the reset wake and a swap's fan-out can both ask at
  // once, and the second pass would only find the first one's runs.
  const previous = store.anthropicResume ?? Promise.resolve([]);
  const pass = previous.catch(() => []).then(resumeWaitingOnce);
  store.anthropicResume = pass;
  return pass;
}

async function resumeWaitingOnce(): Promise<string[]> {
  const waiting = loadRuns()
    .filter((r) => r.status === "paused" && r.pauseReason?.kind === "allowance" && r.pauseReason.meter === "anthropic")
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const resumed: string[] = [];
  for (const run of waiting) {
    try {
      await resumeRun(run.id, { automatic: true });
      resumed.push(run.id);
    } catch (err) {
      const kind = err instanceof CodingAgentError ? err.kind : null;
      console.error(`[coding-agent] ${run.id} could not be resumed after the limit reset:`, err instanceof Error ? err.message : err);
      // Every account limited again, or no slot free: the rest would meet the same answer.
      if (kind === "limited" || kind === "busy") break;
    }
  }
  return resumed;
}

let anthropicWakeInstalled = false;

/**
 * At boot, after the runs are reconciled: read the pool (which migrates the
 * legacy key and arms the reset wake), listen for the wake, and resume anything
 * that was left waiting for a reset that has passed while the box was down.
 */
export async function armAnthropicAccounts(): Promise<void> {
  if (!anthropicWakeInstalled) {
    anthropicWakeInstalled = true;
    onLimitReset(() => {
      void resumeRunsWaitingForAnthropic().catch(() => {});
    });
  }
  // The box-wide swap (TASK-1260): the runs, and the gateway's Claude
  // subscription with its crons, follow the pool's active account from here.
  armCodingSwapConsumer();
  try {
    startGatewaySwap();
  } catch (err) {
    console.error("[coding-agent] could not start the gateway's half of the Anthropic account swap:", err instanceof Error ? err.message : err);
  }
  await startAnthropicAccounts();
  const accounts = accountsSnapshot() ?? [];
  if (pickAccount(accounts, Date.now())) await resumeRunsWaitingForAnthropic();
}

function finishRun(run: CodingRun, state: LiveRun, exitCode: number | null): void {
  // The process is gone and its hook with it: what the hook handed over is
  // recorded, the rest is queued again for the next start (settleRunInbox),
  // and the inbox goes — a respawn makes a fresh one.
  settleRunInbox(run, state);
  removeRunInbox(run.id);
  // The run's process tree is gone, so nothing it spawned is still working —
  // whatever the stream did or did not say about each sub-agent.
  state.openSubagents.clear();
  run.subagentsActive = 0;
  run.activeSubagents = [];
  // An Anthropic account at its usage limit, and what to do about it — decided
  // below, acted on after the cleanup (TASK-902).
  let accountLimit: FoundAccountLimit | null = null;
  let accountAuthText: string | null = null;
  let accountDecision: "switch" | "wait" | "auth" | "moved" | null = null;
  if (run.status === "running") {
    // The device's own stop — the token limit — has already written why on
    // the record. A result event that slipped out before the kill landed
    // must not turn that into "completed" with a "Stopped at the token
    // limit" error beside it: both at once, and the resume the error offers
    // hidden behind a status that says the work is done.
    const deviceStopped = state.endRequested === "stop" && run.error !== null;
    if (state.forcedAccountPause) {
      // The account switch found no account to move the run to, AFTER the
      // process had gone (continueOnAnotherAccount). It settles as the wait it
      // is — paused, session intact — through the ordinary tail below.
      run.status = "paused";
      run.resumable = true;
      run.error = null;
      run.pauseReason = { kind: "allowance", meter: "anthropic", resetsAt: state.forcedAccountPause.resetsAt, message: state.forcedAccountPause.message };
    } else if (state.forcedAccountFailure) {
      // The credential was refused and no account was left to move the run
      // to (continueOnAnotherAccount): a failure with the way out in it.
      run.status = "failed";
      run.error = state.forcedAccountFailure;
    } else if (state.accountMove && state.endRequested === null && state.outcome?.status !== "completed") {
      // The swap ended this process to move the run (moveRunsOffDeadAccounts):
      // not the work failing — the account switch below carries it on.
      run.status = "failed";
      run.error = null;
    } else if (state.simulatedLimit) {
      // The owner's test hook ended this process to stand in for a real limit:
      // settle it exactly as the harness's own limit line would.
      run.status = "failed";
      run.error = state.simulatedLimit;
      state.limitSignal = state.simulatedLimit;
    } else if (state.outcome && !deviceStopped) {
      // The result event's verdict, now that the process is actually gone.
      // Ahead of the stop branch so a stop that raced the final message
      // keeps "completed", as it always has — the OWNER's stop records no
      // error, so it is the one this reaches.
      run.status = state.outcome.status;
      if (state.outcome.resumable) run.resumable = true;
      if (state.outcome.error && !run.error) run.error = redactForRun(run.id, state.outcome.error);
    } else if (state.endRequested === "pause") {
      // Paused, not stopped: the session is intact and Resume respawns into
      // it. completedAt freezes the elapsed clock; resume clears it.
      run.status = "paused";
      run.resumable = true;
      run.error = null;
      // Why, recorded at the gesture — see requestEnd. `?? owner` covers a
      // pause signalled by a path that never went through requestEnd.
      run.pauseReason = state.pauseReason ?? { kind: "owner" };
    } else if (state.endRequested === "stop") {
      run.status = "stopped";
      run.error = run.error ?? "Stopped before it finished.";
    } else if (state.timedOut) {
      run.status = "failed";
      run.error = `Stopped after ${Math.round(RUN_IDLE_TIMEOUT_MS / 60_000)} minutes with no sign of life. The run was not making progress.`;
    } else if (state.lostToRestart) {
      // Its scope was gone at boot and its log has no closing result, so the
      // restart is what ended it. Said as itself rather than as the harness
      // exiting without a result, which is what the branch below would report —
      // a device fault the owner would go looking for and never find.
      run.status = "failed";
      run.error = LOST_TO_RESTART;
    } else {
      run.status = "failed";
      // The harness's own stderr: a curl that failed with the token on its
      // command line lands here whole, so the tail is scrubbed of anything the
      // run was given before it reaches the record or the fault note.
      const tail = redactForRun(run.id, stderrTail(state.stderr));
      // systemd turning the scope away, before the harness ever ran. Recorded
      // for readiness — no probe can find this out by looking — and the retry
      // below then starts the run directly, which is what the box would have
      // done had it known. Only when nothing was heard from the harness at all:
      // once it has spoken, its own words are the failure.
      if (state.unit && !state.sawInit && SCOPE_REFUSED.test(state.stderr)) {
        state.scopeRefused = true;
        state.tools = { ...state.tools, scopePath: null };
        noteScopeRefused(tail);
        console.error(`[coding-agent] ${run.id}: systemd refused the run's scope; running directly from now on`);
      }
      // The same shape for streaming input: the harness turned
      // `--input-format stream-json` away before it ever spoke, so this box's
      // Claude Code cannot be told anything mid-run. Remembered (for half an
      // hour) so later spawns go plain, and the retry below runs plain too —
      // which is the whole difference. Only when nothing was heard from the
      // harness at all: once it has spoken, the flag was accepted and any
      // failure is its own.
      if (state.streamInput && !state.sawInit && STREAM_INPUT_REFUSED.test(state.stderr)) {
        state.streamInputRefused = true;
        noteStreamInputRefused();
        console.error(`[coding-agent] ${run.id}: the harness refused streaming input; messages will wait for a boundary`);
      }
      run.error = runsOnCodex(run.provider)
        // Codex prints its own failures as stream notices ("Reconnecting...",
        // a stream error) before it gives up; the last one is the best account
        // of a run that ended with no verdict, and stderr is the next.
        ? (state.codexNotice ? redactForRun(run.id, state.codexNotice).slice(0, MAX_ERROR_CHARS) : "")
          || tail || `Codex exited with code ${exitCode ?? "unknown"} before reporting a result.`
        : ULTRACODE_REFUSED.test(state.stderr)
          // The CLI refuses the flag before the first turn when dynamic
          // workflows are off for this install or the plan does not allow
          // xhigh. Name the way out rather than echo its /config advice, which
          // the owner cannot follow from the app.
          ? `Claude Code refused ultracode on this box (${tail}). Pick Max effort in the Coding Agent settings and start the run again.`
          : tail || `Claude Code exited with code ${exitCode ?? "unknown"} before reporting a result.`;
    }
    // An `openai` run OpenAI turned away for a usage limit or a refused
    // credential, said in the owner's terms. The limit is remembered, so the
    // provider reads "limited" in the settings and the next run waits for the
    // reset instead of being refused the same way (assertCanSpawn); a run that
    // got its answer clears it. Resumable across a limit: the thread holds
    // the work done so far, and a limit comes good by itself.
    if (runsOnCodex(run.provider)) {
      if (run.status === "completed") {
        void clearOpenAILimit().catch((err: unknown) => {
          console.error(`[coding-agent] ${run.id}: could not clear the OpenAI limit:`, err instanceof Error ? err.message : err);
        });
      } else if (run.status === "failed" && state.endRequested === null && state.codexLimit) {
        const resetsAt = codexLimitUntil(state.codexLimit, Date.now());
        void noteOpenAILimit(resetsAt).catch((err: unknown) => {
          console.error(`[coding-agent] ${run.id}: could not record the OpenAI limit:`, err instanceof Error ? err.message : err);
        });
        run.error = `OpenAI turned this run away at its usage limit; it should be back at about ${formatResetClock(resetsAt)}: ${state.codexLimit}`.slice(0, MAX_ERROR_CHARS);
        if (run.sessionId) run.resumable = true;
      } else if (run.status === "failed" && state.codexAuth) {
        run.error = `OpenAI did not accept this ClawBox's credential (${state.codexAuth}). Reconnect OpenAI in the Coding Agent app → Settings.`.slice(0, MAX_ERROR_CHARS);
      }
    }
    // ClawBox AI refused the run's MODEL calls because one of its rolling
    // allowances is spent. That is not the work failing, and neither a retry
    // nor a fresh run can help before the window frees up — so it settles the
    // way a refused picture does: paused, session intact, with the allowance
    // and its "frees up at" on the record for the card and the agent to say.
    // Only for a run nobody asked to end, and only with a session to come back
    // to; without one there is nothing Resume could carry on from.
    // Only the proxy's own answer counts — its 429 or its `usage_limit`
    // envelope — never words that merely quote a code: a run working on this
    // very codebase can fail with a sentence about `weekly_limit_exceeded`.
    // An OpenAI run's limit is OpenAI's, never the proxy's: it is read below.
    if (run.status === "failed" && state.endRequested === null && run.sessionId && !runsOnCodex(run.provider) && PROXY_REFUSAL_RE.test(run.error ?? "")) {
      const refusal = parseClawaiAllowanceRefusal(run.error);
      if (refusal) {
        run.status = "paused";
        run.resumable = true;
        run.pauseReason = {
          kind: "allowance",
          meter: refusal.kind,
          resetsAt: refusal.resetAt,
          message: (refusal.message ?? run.error ?? "").slice(0, MAX_PAUSE_MESSAGE_CHARS),
        };
        run.error = null;
      }
    }
    // AN ANTHROPIC ACCOUNT AT ITS USAGE LIMIT (TASK-902). The overnight queue
    // died on exactly this on 2026-09-18 — "You've hit your session limit ·
    // resets 10:50pm" — while a second account could have carried on. So the
    // run is not failed: it goes on, in place, on the next account in the
    // owner's order (same record, same session, same worktree and branch, same
    // attempt count), and only when NO account can answer does it wait —
    // paused, with the reset time on the record — for the box to resume it at
    // the first reset. Only a run nobody asked to end, and only on the
    // harness's own limit line (see anthropicLimitOf).
    if (run.status === "failed" && run.provider === "anthropic" && state.endRequested === null && !state.timedOut && !state.forcedAccountFailure) {
      accountLimit = state.accountMove ? null : anthropicLimitOf(run, state);
      // Refused rather than capped, or moved by a swap (TASK-1260): carried on
      // too, through the same continuation, after the cleanup below.
      if (state.accountMove) {
        accountDecision = "moved";
      } else if (!accountLimit) {
        const refused = anthropicAuthFailureOf(run, state);
        const retries = store.anthropicAuthRetries ?? (store.anthropicAuthRetries = new Map<string, number>());
        const spent = retries.get(run.id) ?? 0;
        if (refused && spent < MAX_AUTH_SWITCHES) {
          // Counted per RUN, not per switch: a refusal the probe cannot pin on
          // the account carries the run on on the SAME account, which records
          // no switch — and must still not do it for ever.
          retries.set(run.id, spent + 1);
          accountAuthText = refused;
          accountDecision = "auth";
        }
      }
      if (accountLimit) {
        // Decided NOW, synchronously, off what this process knows of the pool:
        // a pause has to be on the record before the cleanup and the settle
        // below read the status. `null` — the pool has not been read since
        // boot — goes the slow way, which settles the pause itself if it must.
        const another = run.anthropicAccount ? anotherAccountLikely(run.anthropicAccount) : false;
        if (another === false) {
          const resetsAt = earliestAccountReset(run.anthropicAccount, accountLimit.until);
          run.status = "paused";
          run.resumable = true;
          run.error = null;
          run.pauseReason = {
            kind: "allowance",
            meter: "anthropic",
            resetsAt: new Date(resetsAt).toISOString(),
            message: accountLimit.text.slice(0, MAX_PAUSE_MESSAGE_CHARS),
          };
          // The closing words were the limit line, not a report.
          run.summary = null;
          run.resultText = null;
          pushProgress(run, RUNNER_STEP.accountsWaiting(formatResetClock(resetsAt)));
          accountDecision = "wait";
        } else {
          accountDecision = "switch";
        }
      }
    }
  }
  // Only a paused run has a pause to explain. A pause that raced the final
  // message and settled as "completed" instead must not keep a reason for a
  // pause that never happened.
  if (run.status !== "paused") run.pauseReason = null;
  // A stop that raced the final message keeps "completed": the work is done.
  run.exitCode = exitCode;
  run.completedAt = Date.now();
  // The owner's secrets, taken before the cleanup below drops them — for the
  // retry branch alone, which cannot re-resolve them. See restoreRunSecrets.
  const carriedSecrets = runSecretEnv.get(run.id);
  // …with when each dated one of them stops being handed, for that branch.
  const carriedExpiry = runSecretExpiry.get(run.id);
  // …and the Anthropic account it was on, for the same branch and for the
  // account switch below.
  const carriedAccount = runAnthropicCredential.get(run.id);
  // …and its project's MCP servers, for the same two continuations.
  const carriedMcp = runMcpPlan.get(run.id);
  // …and an `openai` run's key, for the retry.
  const carriedOpenAIKey = runOpenAIKey.get(run.id);
  // …and its process group, which the cleanup forgets once it has signalled
  // it: the prune below waits for that group to be gone.
  const settledGroup = run.pgid;
  // Timers, the run's browser tab, and the verdict on what it left running.
  // Before the retry branch below, which respawns into a fresh state and a
  // fresh process group: a retry that inherited the first attempt's timers
  // would be judged idle on the first attempt's clock.
  cleanupRunResources(run, state);
  live.delete(run.id);

  // THE ACCOUNT SWITCH (TASK-902) — see where `accountDecision` is set. The
  // record goes straight back to "running": nothing downstream (the waiters,
  // the review pass, the queue that started the run) is told it finished,
  // because it has not. The move itself is asynchronous (the pool is read and
  // an OAuth token may be renewed), and is tracked like any settle work.
  if ((accountDecision === "switch" && accountLimit) || accountDecision === "auth" || accountDecision === "moved") {
    run.status = "running";
    run.completedAt = null;
    run.exitCode = null;
    run.error = null;
    // The limit line arrived as the result event's text; a continuation that
    // dies without a result must not file it as the run's report.
    run.summary = null;
    run.resultText = null;
    run.lastActivityAt = Date.now();
    persist(true);
    const why: AccountTrouble = accountDecision === "switch" && accountLimit
      ? { kind: "limit", found: accountLimit }
      : accountDecision === "auth"
        ? { kind: "auth", text: accountAuthText ?? "" }
        : { kind: "moved" };
    trackSettleWork(continueOnAnotherAccount(run, state, exitCode, why, carriedSecrets, carriedAccount, carriedMcp));
    return;
  }
  // Not carried on: this stretch of the run is over, and its refused-credential
  // count goes with it rather than staying in the process for ever.
  store.anthropicAuthRetries?.delete(run.id);
  if (accountDecision === "wait" && accountLimit) {
    void recordAccountLimit(run, accountLimit);
  }

  // One automatic restart when the upstream blinked and the run got nowhere.
  //
  // The guards are what make this safe rather than a loop: once only, only a
  // transient shape, only a run the owner did not stop, and only one that
  // changed NOTHING — no files and no command that may have side effects. A
  // read-only inspection such as `ls -la` is safe and must not suppress the
  // recovery, and neither is a convergent setup step such as `npm install`:
  // a fresh attempt re-creates its leftovers rather than tripping over them.
  // A run that may have edited something must never be silently repeated,
  // because the second attempt starts from the first one's leftovers.
  //
  // A FRESH session, never a resume: Claude Code persists the failure in the
  // session and replays it, which is how one bad run became two identical
  // ones on this box. See CodingRun.resumable.
  if (
    run.status === "failed"
    && run.retries === 0
    && state.endRequested === null
    && !state.timedOut
    // A scope systemd refused counts here too: the harness never started, so
    // nothing happened that a second attempt could trip over — and this one goes
    // without the scope, which is the whole difference.
    // A refused `--input-format` counts here for the reason a refused scope
    // does: the harness never started, so nothing happened that a second
    // attempt could trip over — and this one goes without the flag.
    && (isTransientFailure(run.error) || state.scopeRefused || state.streamInputRefused)
    && run.filesTouched.length === 0
    && !state.sawWriteAttempt
    && !state.commandMayHaveSideEffects
  ) {
    {
      run.retries = 1;
      run.status = "running";
      run.completedAt = null;
      run.exitCode = null;
      run.error = null;
      // The first attempt's closing words too: a 503 arrives as a result event
      // and lands in the summary, and the report is filed from the summary
      // once the run settles. Left in place, a second attempt that dies
      // without a result would file the first one's error as its report.
      run.summary = null;
      run.resultText = null;
      run.sessionId = null;
      run.numTurns = 0;
      run.subagentsTotal = 0;
      pushProgress(run, RUNNER_STEP.providerSilent);
      persist(true);
      console.error(`[coding-agent] ${run.id} retrying once after a transient upstream failure`);
      // The same credentials and the same redaction table as the attempt that
      // got nowhere: this is one run making a second try at the same work, not
      // a new decision by the owner. Less a dated copy whose day ended while the
      // first attempt ran: one is never handed after its day, whoever hands it.
      if (carriedSecrets || carriedAccount || carriedMcp || carriedOpenAIKey) {
        restoreRunSecrets(run.id, withoutPastDueSecrets(carriedSecrets ?? {}, carriedExpiry ?? {}), carriedAccount, carriedMcp, carriedOpenAIKey);
      }
      try {
        spawnRun(run, null, state.tools, state.settings);
        // The retry is the same run's second try at the same work, seconds
        // later: a model that answered the first attempt answered this run,
        // so the harness-fault verdict below sees both (TASK-1320).
        const retried = live.get(run.id);
        if (retried && retried !== state) {
          retried.tokensAtSpawn = state.tokensAtSpawn;
          retried.sawModelAnswer = state.sawModelAnswer;
        }
        return;
      } catch (err) {
        // The retry could not even start; fall through and report the
        // original shape of failure rather than losing the run.
        run.status = "failed";
        run.completedAt = Date.now();
        run.error = `Retry could not start: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
        auditUnstartedSpawn(run.id);
        // And take back what restoreRunSecrets put in memory for a child that
        // never came into being. The cleanup above this branch has already run
        // and will not run again, so without this the owner's plaintext would
        // sit in this process until it restarted (found in review).
        dropRunSecrets(run.id);
        // …and on disk: the spawn may have written its MCP config, with the
        // project's server credentials, before it threw.
        removeRunMcpConfigs(run.id);
      }
    }
  }

  // THE HARNESS ITSELF, once the retry above has had its turn.
  //
  // Deliberately here and not in the branches that set `error`: a fault is
  // only a fault after the one automatic retry has failed to shake it off.
  // Before that, the very same line is how an entitlement flap looks, which
  // is why `unrecognized_model` is in the transient set and stays there — the
  // retry is what tells the two apart.
  //
  // The owner used to be handed the CLI's own line whole
  // ('[claude-code:unrecognized_model] {"model":…}') and nothing else, and
  // the next run walked into the identical wall. So the record gets a
  // sentence a person can act on with the raw line kept after it, the verdict
  // is recorded as a FIELD so the card can word it in the owner's language,
  // and the fault is remembered long enough to refuse the next run before it
  // spawns rather than after it dies.
  //
  // Not resumable, whatever the result event claimed: the session holds no
  // work, and Claude Code replays a failure that is in the session.
  //
  // And only BEFORE the first answer. The same line after a model has answered
  // this run proves nothing about the harness — it plainly could get a model
  // to answer — and recorded, it refused every run for fifteen minutes: a
  // bench worker 347 s and 563,595 tokens into its task hit one, and the next
  // 16 team goals were turned away in ~35 ms each on a box that was answering
  // fine (run-dazazpqx, TASK-1320). That run fails with its own error, whole,
  // like any other failure of the run, and nothing is remembered.
  // THIS spawn's bill (and its retry's), not the record's: see tokensAtSpawn.
  const spawnTokens = Math.max(0, run.tokensUsed - state.tokensAtSpawn);
  run.spawnTokens = [...run.spawnTokens, spawnTokens].slice(-MAX_SPAWN_TOKENS_KEPT);
  // Claude Code's harness only: a Codex run that could not get an answer is
  // OpenAI's or the Codex CLI's to explain, and a fault recorded for it would
  // refuse every Claude run on the box for nothing.
  const harnessVerdict = run.status === "failed" && !runsOnCodex(run.provider)
    ? classifyHarnessFailure(run.error, { tokensUsed: spawnTokens, sawModelAnswer: state.sawModelAnswer })
    : null;
  if (harnessVerdict === "run_failure") {
    console.error(`[coding-agent] ${run.id} hit a model error after the model had answered (${spawnTokens} tokens this spawn); failed as the run's own error, no harness fault recorded`);
  }
  if (harnessVerdict === "harness_not_ready") {
    run.failureKind = "harness_not_ready";
    run.error = harnessFaultMessage(run.error);
    run.resumable = false;
    void rememberHarnessFault().catch((err: unknown) => {
      // Said, not swallowed: the durable copy is gone and only this process
      // will refuse the next run, which is exactly the kind of degraded state
      // that should be in the log rather than inferred from behaviour.
      console.warn("[coding-agent] could not persist the harness fault:", err instanceof Error ? err.message : err);
    });
  } else if (run.status === "completed") {
    // The only proof that matters. A box that was refusing runs because of a
    // fault is plainly working now, so the fault goes rather than waiting out
    // its clock.
    void clearHarnessFault().catch(() => {});
  }

  // The closing message becomes report.md beside the run's screenshots — for
  // a run that did not finish too, when it said anything, because a partial
  // account is what the owner reads before deciding whether to resume. After
  // the retry decision above, so a restarted run never files its first
  // attempt's words; never throwing, so the record settles regardless.
  if (run.resultText || run.summary) writeRunReport(run.id, run.resultText || run.summary!);

  // The COMMIT before anyone is told. Waiters — the team orchestrator above
  // all — act on "finished" at once: a worker's worktree was merged and
  // removed the moment its run settled, while the commit was still on its
  // way, so the branch stayed at the scaffold and the reviewer rejected work
  // that had been done (team-8l9oudxd, t1 and t2, 2026-09-05). So the
  // record is committed first; "Finished" is said and the waiters woken only
  // once the work is recoverable; the assets, the review pass and the pull
  // request follow on their own, as before.
  // Held, not fired and forgotten: this whole chain outlives the run it
  // settles, and until it was tracked nothing — not even the module's own
  // reset — could wait for it. See `trackSettleWork`.
  const settled = run.status;
  // Read now, not after the commit below: the owner's Kill clears it while the
  // group it named may still be on its way out.
  const leftRunning = run.leftover;
  // Until the wake below, a wait that begins now waits too (waitForRun): the
  // status already says settled, the branch does not have the work yet.
  store.unannounced.add(run.id);
  trackSettleWork((async () => {
    try {
      await recordRunWork(run);
      // The lessons the run proposed for its project's notes
      // (src/lib/coding-run-notes.ts), vetted and merged before anyone waiting
      // on it is woken — a team's next worker reads them. Not for a pause: the
      // run is not over, and its next spawn may still change its mind.
      if (settled !== "paused") {
        const notes = await settleRunNotes(run, artifactsDir(run.id)).catch(() => ({ added: [], refused: [] }));
        if (notes.added.length || notes.refused.length) {
          console.error(`[coding-agent] ${run.id}: run notes +${notes.added.length}${notes.refused.length ? `, refused ${notes.refused.map((r) => r.reason).join(", ")}` : ""}`);
        }
      }
      // Before "finished", so the owner reads why something left the evidence
      // folder next to the run that put it there — and before any waiter or
      // update can find it: see pruneArtifacts. Not while something the run
      // started is still running: it can still change the folder under the walk.
      // A run that left something running on purpose is not pruned at all; a
      // group the cleanup signalled is waited for, up to its SIGKILL and a
      // margin — something that shrugs off SIGTERM is still there until then.
      if (!leftRunning && (await groupGone(settledGroup, STOP_GRACE_MS + 1_000))) {
        const pruned = await pruneArtifacts(run.id);
        if (pruned.length > 0) pushProgress(run, RUNNER_STEP.evidencePruned(prunedPaths(pruned)));
      }
      pushProgress(run, settled === "paused" ? RUNNER_STEP.paused : RUNNER_STEP.finished(settled));
      persist(true);
    } finally {
      // Woken even when the bookkeeping above threw: a run that is over must
      // not keep every later wait on it for its whole slice.
      wakeWaiters(run.id);
      // A slot is free: the queue's next run, in its turn.
      void pumpRunQueue();
    }
    console.error(`[coding-agent] ${run.id} ${settled} after ${Math.round(((run.completedAt ?? Date.now()) - run.startedAt) / 1000)}s (${run.numTurns} turns)`);
    // A team's worker or reviewer ends here: its worktree is the
    // orchestrator's to merge and remove the moment it is woken, its
    // review is the team's own reviewer's, and it never opens a pull
    // request — the assets, review pass and PR below would run in a folder
    // that is gone. The planner works in the project itself and keeps them.
    try {
      if (run.team && run.team.role !== "planner") return;
      await reviewAndShip(run, state.endRequested);
    } finally {
      // The copies the owner limited to this one run go once it is over — here,
      // at the END of the chain and not at the settle above it: the deliverable
      // gate and the delivery pipeline (both inside reviewAndShip) can put this
      // very record back to work, and that attempt is still its one run. A
      // pause, or a record back at work, keeps them; that attempt's own settle
      // comes back through here.
      if (!isRunGoing(run.id)) endRunSecrets(run);
    }
  })());
  // A pause is the owner's own gesture — no finish notice for it.
  //
  // And neither is a run whose deliverable has not been looked at yet: "Coding
  // agent finished run-x" is exactly the claim this feature exists to stop
  // making on the harness's word alone, and the run may be back at work
  // seconds later. `enforceDeliverable` sends it once it knows what the run
  // actually is — the two read the same predicate so no run falls between them.
  // A live DELIVERY PIPELINE holds it for the same reason and by the same
  // rule: the run is about to be reviewed, improved, deployed and checked, and
  // "Coding agent finished run-x" now would be exactly the claim the pipeline
  // exists to stop making. `settlePipelineRun` sends it when the pipeline is
  // actually over.
  if (run.status !== "paused" && !deliverableGateApplies(run) && !pipelineOwnsRun(run)) {
    void announceCodingAgent(cloneRun(run)).catch((err: unknown) => {
      console.error("[coding-agent] announce failed:", err instanceof Error ? err.message : err);
    });
  }
}

function installExitHook(): void {
  if (store.exitHookInstalled) return;
  store.exitHookInstalled = true;
  process.on("exit", () => {
    for (const state of live.values()) {
      // A run in its own scope is MEANT to outlive this process: that is the
      // whole point of the scope, and the next web server reattaches to it
      // (reconcileAfterRestart). Only a plain child is ended here, because an
      // orphan of that kind has nothing left that could find it again.
      if (state.unit) continue;
      if (state.child) killTree(state.child, "SIGTERM");
    }
  });
}

// ─── The stream log: a run's output, on disk rather than down a pipe ─────────

/** At most this many chunks are read from one log in one tick: 10 MB, which no
 *  real run produces in 200 ms and which bounds a pathological one. */
const STREAM_PASSES_PER_TICK = 20;

/**
 * Open this run's stream and stderr logs for the harness to write into.
 *
 * Truncating, not appending: each spawn of a record is a fresh stream and the
 * offsets restart with it. Throws, so `spawnOrSettle` settles the record with a
 * reason rather than starting a run nothing can read.
 */
function openStreamLogs(runId: string): { out: number; err: number } {
  fs.mkdirSync(STREAM_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(streamLogPath(runId), "w", 0o600);
  try {
    return { out, err: fs.openSync(stderrLogPath(runId), "w", 0o600) };
  } catch (err) {
    fs.closeSync(out);
    throw err;
  }
}

function removeStreamLogs(runId: string): void {
  for (const file of [streamLogPath(runId), stderrLogPath(runId)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort: a log left behind costs disk, never correctness
    }
  }
}

/** The last words the harness printed, bounded — what a failure without a result is reported as. */
function readStderrLog(file: string | null): string {
  if (!file) return "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const want = Math.min(size, MAX_STDERR_CHARS);
      if (want <= 0) return "";
      const buf = Buffer.allocUnsafe(want);
      const read = fs.readSync(fd, buf, 0, want, size - want);
      const text = buf.subarray(0, Math.max(read, 0)).toString("utf-8");
      // A byte offset can land mid-line and mid-character. When the tail was cut
      // short of the file, the first partial line goes with the cut rather than
      // reaching the owner with a replacement character glued to its front.
      if (want < size) {
        const nl = text.indexOf("\n");
        return nl >= 0 ? text.slice(nl + 1) : "";
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Whole lines out of the tail, through the same handler the pipe used to feed. */
function consumeStreamText(run: CodingRun, state: LiveRun, text: string): void {
  const stream = state.stream;
  if (!stream) return;
  stream.buffer += text;
  let nl = stream.buffer.indexOf("\n");
  while (nl >= 0) {
    const line = stream.buffer.slice(0, nl).trim();
    stream.buffer = stream.buffer.slice(nl + 1);
    if (line && line.length <= MAX_STDOUT_LINE_CHARS && line.startsWith("{")) {
      try {
        const event = JSON.parse(line) as unknown;
        // The same log and the same tail for both runners; only the reading
        // differs — Claude Code's stream-json, or Codex's `exec --json`.
        if (runsOnCodex(run.provider)) handleCodexEvent(run, state, event);
        else handleEvent(run, state, event as StreamEvent);
        // The stream's own cadence, not the state one: a harness emits lines
        // far faster than anybody reads the record, and each flush rewrites
        // the whole file.
        persist(false, STREAM_FLUSH_MS);
      } catch {
        // not JSON — Claude Code prints the odd plain line; ignore it
      }
    }
    nl = stream.buffer.indexOf("\n");
  }
  if (stream.buffer.length > MAX_STDOUT_LINE_CHARS) stream.buffer = "";
}

/**
 * Read whatever the harness has written since the last look.
 *
 * The file is opened per pass rather than held: a run's log outlives the process
 * that reads it, and a held descriptor would keep a deleted one alive and hide a
 * replacement. A log that is not there yet is not an error — the harness has
 * simply not printed its first line.
 */
function drainStream(run: CodingRun, state: LiveRun): void {
  const stream = state.stream;
  if (!stream) return;
  for (let pass = 0; pass < STREAM_PASSES_PER_TICK; pass += 1) {
    let chunk: Buffer;
    try {
      const fd = fs.openSync(stream.path, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= stream.offset) return;
        const want = Math.min(size - stream.offset, STREAM_READ_CHUNK);
        const buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, stream.offset);
        if (read <= 0) return;
        stream.offset += read;
        chunk = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    // On the record, so the NEXT web server resumes the tail here instead of
    // replaying the run from its first line.
    run.streamOffset = stream.offset;
    consumeStreamText(run, state, stream.decoder.write(chunk));
  }
}

/** Follow this run's log from wherever it has been read to. */
function followStream(run: CodingRun, state: LiveRun): void {
  state.stream = { path: streamLogPath(run.id), offset: run.streamOffset, buffer: "", decoder: new StringDecoder("utf8") };
  state.stderrPath = stderrLogPath(run.id);
  state.streamTimer = setInterval(() => {
    drainStream(run, state);
    // The hook's receipts, while there is anything in the inbox to look for.
    if (state.inboxPosted.size > 0) collectInboxReceipts(run, state);
  }, STREAM_POLL_MS);
  state.streamTimer.unref();
}

/**
 * Everything the harness said that this process has not read yet, plus its
 * stderr — called once more on the way into every settle, because the last
 * events of a run arrive in the same instant it exits.
 */
function drainForSettle(run: CodingRun, state: LiveRun): void {
  drainStream(run, state);
  const stderr = readStderrLog(state.stderrPath);
  if (stderr) state.stderr = stderr.slice(-MAX_STDERR_CHARS);
}

/**
 * The argv the box actually spawns: `setpriv`, the capability-dropping flags,
 * then the wrapper and its own arguments. Exported for the contract test —
 * this prefix is a security boundary, not a detail.
 */
export function buildSpawnArgv(setprivPath: string, claudeArgs: string[]): { bin: string; argv: string[] } {
  return { bin: setprivPath, argv: [...CAPABILITY_DROP_ARGS, wrapperPath(), ...claudeArgs] };
}

/** The same prefix in front of the Codex CLI, for an `openai` run. Exported for the contract test. */
export function buildCodexSpawnArgv(setprivPath: string, codexArgs: string[]): { bin: string; argv: string[] } {
  return { bin: setprivPath, argv: [...CAPABILITY_DROP_ARGS, codexBinary(), ...codexArgs] };
}

/**
 * The Codex argv of an `openai` run (src/lib/coding-codex.ts): the same brief a
 * Claude run gets, as developer instructions, and the run's own clawbox MCP
 * server when it holds any of its tools. Never the project's harness servers:
 * their credentials would have to travel in argv (prepareRunMcp says so in the
 * run's feed). Exported for the contract test.
 */
export function buildCodexRunArgs(opts: RunArgsOptions & { model: string; readOnlyTools?: boolean }): string[] {
  const diet = opts.diet ?? LEGACY_DIET;
  const visual = runHoldsVisualTools(diet, opts.visual);
  const developerInstructions = buildRunSystemPrompt({
    ...opts,
    // Ultracode's brief is about Claude Code's Workflow tool, which Codex does
    // not have; its thinking half is the reasoning effort (codexReasoningEffort).
    effort: opts.effort === ULTRACODE_EFFORT ? "xhigh" : opts.effort,
    noHelpers: true,
  });
  const run = opts.run;
  const mcpServers: Record<string, CodexMcpServer> = {};
  if (run && !opts.readOnly && (visual || run.team || opts.readOnlyTools)) {
    mcpServers.clawbox = runClawboxServer(run, { visual, readOnlyTools: opts.readOnlyTools === true });
  } else if (run && opts.readOnly && run.team) {
    // A read-only team run still speaks to its team (MCP_TEAM_TOOL).
    mcpServers.clawbox = runClawboxServer(run, { visual: false, readOnlyTools: false });
  }
  return buildCodexArgs({
    model: opts.model,
    effort: opts.effort ?? DEFAULT_EFFORT,
    developerInstructions,
    resumeSessionId: opts.resumeSessionId ?? null,
    mcpServers,
    readOnly: opts.readOnly === true,
  });
}

/**
 * The run's command fence for Codex: the kill deny-list every Claude run gets,
 * as execpolicy rules in the coding agent's CODEX_HOME. Rewritten at each spawn
 * so a box that updates gets the current list. Best effort — a run that could
 * not have its rules written still has its brief, as a Claude run whose hook
 * failed does — and said in the log.
 */
function writeCodexRules(runId: string): void {
  try {
    const dir = path.join(ensureCodexHome(), "rules");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "clawbox.rules");
    const tmp = untraced(`${file}.${runId}.tmp`);
    fs.writeFileSync(tmp, codexRulesText(BASH_KILL_DENYLIST, "A run ends what it started by PID; killing by name or every process can take this ClawBox down."), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[coding-agent] ${runId}: could not write the Codex rules:`, err instanceof Error ? err.message : err);
  }
}

function spawnRun(
  run: CodingRun,
  resumeSessionId: string | null,
  tools: SpawnTools,
  settings: { effort: CodingEffort; maxTurns: number },
  stdinText?: string,
  /**
   * This spawn CONTINUES a record that has already had a result event, so the
   * per-segment counters add up instead of starting over.
   *
   * `state.sawResult` is what `handleEvent` reads to decide that, and a fresh
   * `LiveRun` has it false — correct for every other spawn, because a resume
   * with `resumeRunId` makes a NEW record whose counters genuinely start at
   * zero. A completion attempt is the one spawn that re-enters the SAME record:
   * without this its result event overwrote `numTurns`, `permissionDenials`,
   * `deniedActions` and `denials`, so a refusal from the first attempt — and the
   * "Allow next time" button that answers it — vanished when the second ran.
   */
  continuingRecord = false,
): void {
  // Whose review is this run's diff getting? The owner's automatic pass (as
  // the switch stood when the run started — run.reviewPass), a team's
  // reviewer (every task gets one — coding-team-reviewer.ts), or the run IS
  // the pass: in each case the flash reviewer would be a second look.
  const reviewedSeparately = run.reviewPass || run.reviewOf !== null || run.team !== null;
  // An `openai` run is the Codex CLI, not Claude Code (src/lib/coding-codex.ts).
  const codex = runsOnCodex(run.provider);
  // Streaming input unless this box's harness has been caught refusing the
  // flag (coding-run-messages.ts). It is what keeps the harness's stdin open
  // for the life of the run, so a message the owner sends at minute three can
  // be written as the next user turn instead of waiting for a boundary.
  // `codex exec` reads its prompt once and has no such mode: a message to a
  // Codex run waits for the next boundary, as on a box whose CLI refused it.
  const streamInput = codex ? false : streamInputAvailable();
  // "opening" is the auto-PR path's promise to open or adopt a pull request
  // from this run's branch when it settles, and then to watch it — see
  // PR_DRAFT_BRIEF.
  const draftPullRequests = run.pr?.phase === "opening";
  // The run's inbox and hooks (src/lib/coding-run-inbox.ts). Whatever the
  // previous spawn's hook did not take is the queue's again first — that
  // process is gone, and the queue below is delivered this spawn's way.
  settleRunInbox(run, null);
  // Codex takes no per-run hooks, so no inbox and no merge guard (its command
  // fence is the execpolicy rules below).
  const hookSettings = codex ? null : spawnHookSettings(run);
  run.midTurn = hookSettings !== null && hookSettings.inbox;
  // The CPU budget frozen at start; a record from before it existed gets the
  // lone-run figure rather than none.
  const cpuBudget = run.cpuBudget ?? runCpuBudget({ cpus: hostCpuCount() });
  // The project's run notes, read at EVERY spawn (src/lib/coding-run-notes.ts):
  // a completion attempt or a resume sees a lesson the owner added meanwhile.
  const runNotes = runNotesBlock(readRunNotes(run.directory));
  // The token diet's visual decision, made ONCE — at this record's first
  // spawn — and kept for every respawn, so the run's tools and its prompt
  // prefix never move under it (CodingRun.visual).
  if (run.visual === null) run.visual = decideRunVisual(run.diet, run.task, run.directory);
  // The project's MCP servers (prepareRunMcp), written for THIS spawn into a
  // 0600 file the harness reads at start; the settle deletes it. A run whose
  // project ticked nothing has no plan, writes nothing and keeps today's argv.
  removeRunMcpConfigs(run.id);
  const mcpPlan = run.readOnly ? undefined : runMcpPlan.get(run.id);
  const runMcp: RunMcpArgs | null = mcpPlan && !codex
    ? {
        configFile: writeRunMcpConfig(run.id, buildRunMcpFileConfig({ id: run.id, directory: run.directory, media: run.media, team: run.team }, mcpPlan, { visual: runHoldsVisualTools(run.diet, run.visual) })),
        allowedTools: mcpPlan.allowedTools,
        disallowedTools: mcpPlan.disallowedTools,
        readOnlyTools: mcpPlan.readOnlyTools,
      }
    : null;
  const runArgs: RunArgsOptions = { resumeSessionId, maxTurns: settings.maxTurns, effort: settings.effort, readOnly: run.readOnly, extraBrief: run.extraBrief, experience: run.experienceBrief, reviewedSeparately, draftPullRequests, allowRules: run.allowRules, provider: run.provider, streamInput, hookSettings: hookSettings?.json ?? null, cpuBudget, runNotes, lessonChannel: !run.readOnly, run: { id: run.id, directory: run.directory, media: run.media, team: run.team }, diet: run.diet, visual: run.visual, pullRequestMentioned: mentionsPullRequest(run.task), mcp: runMcp };
  if (codex) writeCodexRules(run.id);
  const dropped = codex
    ? buildCodexSpawnArgv(tools.setprivPath, buildCodexRunArgs({ ...runArgs, model: run.requestedModel ?? defaultModelForProvider(run.provider) ?? DEFAULT_OPENAI_MODEL, readOnlyTools: mcpPlan?.readOnlyTools === true }))
    : buildSpawnArgv(tools.setprivPath, buildRunArgs(runArgs));
  // One evidence path everywhere — env, MCP config and --add-dir must never
  // disagree about where it is. Creation is best-effort: the MCP layer also
  // mkdirs lazily, so a failure here degrades evidence, never the run.
  const evidenceDir = artifactsDir(run.id);
  try {
    ensureArtifactsDir(run.id);
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: no artifacts folder:`, err instanceof Error ? err.message : err);
  }
  // The run's own cgroup, when this box can give it one. The scope is what makes
  // the run outlive the web server; `buildSpawnArgv`'s capability drop is
  // untouched on the far side of the `--`, because that prefix is the security
  // boundary and this one is only a cgroup. A per-spawn suffix, so a retry is
  // never refused the name of a scope systemd is still collecting.
  const unit = tools.scopePath ? runScopeUnit(`${run.id}-${Date.now().toString(36)}`) : null;
  const { bin, argv } = unit && tools.scopePath
    ? buildScopeArgv(tools.scopePath, unit, dropped.bin, dropped.argv)
    : dropped;
  // Output to FILES, not pipes: a run whose parent has died would be killed by
  // the first line it printed down a closed pipe, which would undo the scope.
  // The web server tails the log instead — see STREAM_DIR.
  const logs = openStreamLogs(run.id);
  run.streamOffset = 0;
  // The secrets were resolved on the async path just before this call
  // (prepareRunSecrets), or put back for the transient retry, which respawns
  // from a `close` handler and cannot read the disk (restoreRunSecrets).
  // Absent — `undefined`, which the merge loop reads as nothing — for every
  // run on a box that has not switched injection on.
  const runEnv = buildRunEnv({ effort: settings.effort, artifactsDir: evidenceDir, inputsDir: runInputsDir(run.id), provider: run.provider, model: run.requestedModel, cpuBudget, secrets: runSecretEnv.get(run.id), diet: run.diet });
  // The Anthropic account this spawn is on (prepareRunSecrets chose it). Its
  // credential goes into a one-shot 0600 file the wrapper reads and deletes
  // before exec; only the file's PATH is in the environment — the credential
  // itself never is, and never in argv. No entry means the wrapper's own
  // fallback: the legacy key, else the `claude` sign-in.
  const account = run.provider === "anthropic" ? runAnthropicCredential.get(run.id) : undefined;
  // The owner's secrets this spawn carries, for the audit line that is written
  // once the child's fate is known — see auditRunHandOff.
  const handOff = runHandOffOf(run.id);
  let child: ChildProcess;
  try {
    // Inside the `try`: the handoff can throw (a full disk, a folder it cannot
    // make), and the `finally` must still close the two logs opened above. The
    // settle path takes any file it did write (removeCredentialHandoffs).
    if (account) runEnv.CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE = writeCredentialHandoff(run.id, account.credential);
    // An `openai` run on the owner's saved key: the one variable `codex exec`
    // authenticates with. Codex keeps it from the commands the run starts
    // (shell_environment_policy, coding-codex.ts) and the redaction table holds
    // it (registerRunRedaction). Without a key, Codex reads the ChatGPT sign-in
    // out of its own CODEX_HOME.
    if (codex) {
      const key = runOpenAIKey.get(run.id);
      if (key) runEnv[CODEX_API_KEY_ENV] = key;
    }
    child = spawn(bin, argv, {
      cwd: run.directory,
      // Deliberately NOT process.env: see the header. The cast is only because
      // this repo's ProcessEnv augmentation insists on NODE_ENV, which a run has
      // no use for.
      // The provider and the model come off the RUN, not off the settings: they
      // were frozen when it started, and a resume must re-enter the session on
      // the same account it was opened with.
      //
      // `scopeEnv` adds the one variable systemd-run needs from a SYSTEM service
      // — the user runtime dir it composes the bus address from — and nothing
      // else: the run's environment is still built from scratch, not inherited.
      env: (unit ? scopeEnv(runEnv) : runEnv) as NodeJS.ProcessEnv,
      detached: true,
      // `spawn` dups these into the child before it returns, which is why the
      // `finally` below may close this process's copies at once.
      stdio: ["pipe", logs.out, logs.err],
    });
  } finally {
    // Node has dup'd them into the child (or there is no child); this process
    // has no use for them and a leaked descriptor would keep a deleted log
    // alive for the server's life.
    fs.closeSync(logs.out);
    fs.closeSync(logs.err);
  }
  // `spawn` returning is not the process starting: an exec that fails (the
  // wrapper missing, ENOENT) arrives as "error" instead of "spawn", and the line
  // follows whichever comes first. A later "error" (a signal that could not be
  // delivered) is about a child that had started, and changes nothing here.
  let started = false;
  child.once("spawn", () => {
    started = true;
    auditRunHandOff(run.id, handOff, true);
  });
  child.once("error", () => {
    if (!started) auditRunHandOff(run.id, handOff, false);
  });
  // A run with no scope of its own gets the scope's nice level by hand, so the
  // desktop is preferred over it either way. Set on the harness before it has
  // forked anything worth the name; every child inherits it. Best effort: a
  // run that could not be reniced still runs.
  if (!unit && typeof child.pid === "number") {
    try {
      os.setPriority(child.pid, RUN_NICE);
    } catch {
      // Not ours to renice (a pid already gone): the run settles on its own.
    }
  }

  const state: LiveRun = {
    child,
    unit,
    // `detached: true` makes the child its own process-group leader, and
    // systemd-run execs the harness in its own process, so this pid is the group
    // whichever of the two started it.
    pgid: typeof child.pid === "number" ? child.pid : null,
    stream: null,
    streamTimer: null,
    unitWatch: null,
    stderrPath: null,
    scopeRefused: false,
    streamInput,
    // Set once the first turn has actually been written below; a spawn whose
    // stdin threw never had an open pipe to close.
    stdinOpen: false,
    midTurn: run.midTurn === true,
    turnOpen: true,
    inboxPosted: new Set<string>(),
    streamInputRefused: false,
    lostToRestart: false,
    openSubagents: new Map<string, ActiveSubagent>(),
    billedMessageIds: new Set<string>(),
    outputBilledInSegment: 0,
    helperBilled: new Map<string, number>(),
    pendingFiles: new Map<string, string>(),
    worktreeTargets: new Map<string, { tool: string; counterpart: string }>(),
    worktreeHinted: new Set<string>(),
    sawWriteAttempt: false,
    sawModelAnswer: false,
    tokensAtSpawn: run.tokensUsed,
    breakdownAtSpawn: { ...run.tokenBreakdown },
    resumedSession: Boolean(resumeSessionId),
    sawThinking: false,
    thinkingSeen: 0,
    // A Codex thread reports its usage cumulatively: what it had billed before
    // this spawn is taken off (applyCodexUsage).
    ...(codex ? { codexBaseline: codexUsageBaseline(resumeSessionId) } : {}),
    tools,
    settings,
    commandMayHaveSideEffects: false,
    // A rolling check, not a deadline: a run that keeps producing events is
    // allowed to work for as long as it needs.
    timeout: setInterval(() => {
      const idleFor = Date.now() - run.lastActivityAt;
      if (idleFor < RUN_IDLE_TIMEOUT_MS) return;
      state.timedOut = true;
      endProcess(state);
    }, IDLE_CHECK_MS),
    killTimer: null,
    endRequested: null,
    allowanceRefusal: null,
    pauseReason: null,
    limitSignal: null,
    simulatedLimit: null,
    forcedAccountPause: null,
    authSignal: null,
    accountMove: false,
    forcedAccountFailure: null,
    timedOut: false,
    sawResult: continuingRecord,
    sawInit: false,
    outcome: null,
    stderr: "",
  };
  state.timeout.unref();
  live.set(run.id, state);
  // Recorded now rather than derived at settle: by then the child object is the
  // only thing that still knows the group, and a leftover server has to be
  // reachable after `live` has forgotten the run. The UNIT is recorded for the
  // same reason and one more — after a restart it is the only handle on a run
  // this server never spawned, and a recycled pid is no handle at all.
  run.pgid = state.pgid;
  run.unit = unit;
  followStream(run, state);
  installExitHook();

  let settled = false;
  const settle = (code: number | null) => {
    if (settled) return;
    settled = true;
    // The run's last events land in the same instant it exits, and its stderr is
    // only ever read here.
    drainForSettle(run, state);
    finishRun(run, state, code);
  };

  child.on("error", (err) => {
    // Typically ENOENT: the wrapper is not where install.sh puts it.
    run.status = "failed";
    run.error = `Could not start ${codex ? CODEX_COMMAND : CODING_HARNESS_COMMAND}: ${err.message}`.slice(0, MAX_ERROR_CHARS);
    settle(null);
  });
  // Settled a moment after the process is gone rather than the instant it is:
  // the harness's last lines are in the log file, and a grandchild that
  // inherited the descriptor may still be finishing them off.
  const settleSoon = (code: number | null) => {
    setTimeout(() => settle(code), SETTLE_DRAIN_DELAY_MS).unref();
  };
  child.on("exit", settleSoon);
  child.on("close", settleSoon);

  // A resumed conversation remembers the PREVIOUS run's evidence folder and
  // was seen writing there (run-qqj1io65: screenshots filed under the old
  // run, Write into its own folder refused). The env and --add-dir already
  // name the new folder; the session's memory needs telling too.
  // What this run was HANDED, named in the same breath as the folder listing:
  // the brief says inputs live in CLAWBOX_RUN_INPUTS_DIR, and a run told the
  // file names up front opens them rather than globbing for them. Said even
  // when nothing was staged, because "you were given nothing" is what stops a
  // run hunting for a picture the assistant only meant to generate.
  const inputsNote = runInputsNote(run);
  const firstTurn = stdinText ?? (resumeSessionId
    ? `${run.task}\n\n[ClawBox harness: this continuation is a NEW run. Its evidence folder is ${artifactsDir(run.id)} — save screenshots and report.md there, not in any previous run's folder. ${inputsNote}]`
    : `${run.task}\n\n[ClawBox harness: ${folderListing(run.directory)} ${inputsNote}]`);
  try {
    child.stdin?.on("error", () => {
      // EPIPE when the wrapper dies before reading the task; `exit` reports it.
      state.stdinOpen = false;
    });
    if (streamInput) {
      // One JSON line, and the pipe stays open. The CLI answers the turn and
      // then waits for more — which is what `afterTurn` closes, once there is
      // nothing left to say.
      state.stdinOpen = true;
      child.stdin?.write(streamJsonUserTurn(firstTurn));
      // Anything queued before the process existed — a message sent to a
      // draft, or one that raced the start — goes to the inbox, for the
      // first tool call; with no hook, in right behind the task rather than
      // waiting for the first turn to end.
      deliverRunMessages(run, state);
    } else {
      // No pipe to write to later, so anything already queued rides out with
      // the task itself — the boundary delivery, applied at the one boundary
      // every spawn is. A start, the owner's Resume and another attempt at the
      // deliverable all arrive here, so none of them needs its own copy.
      const waiting = queuedMessages(run.messages);
      const note = runMessagesNote(run.messages);
      if (child.stdin) {
        child.stdin.end(note ? `${firstTurn}\n\n${note}` : firstTurn);
        // Only once the bytes are on the pipe: with no stdin at all nothing
        // was said, and the queue is still the box's to deliver.
        noteMessagesDelivered(run, waiting, "with_start");
      }
    }
  } catch {
    // reported through the exit path
    state.stdinOpen = false;
  }
}

/**
 * Mark these messages delivered and say so in the run's feed.
 *
 * The two go together on purpose: "delivered" is a claim the owner reads on
 * the card, and the feed line is what makes the same fact visible in the
 * transcript preview and on the timeline.
 */
function noteMessagesDelivered(run: CodingRun, messages: readonly RunMessage[], via: RunMessageVia, at = Date.now()): void {
  let marked = 0;
  for (const message of messages) {
    if (message.deliveredAt !== null) continue;
    message.deliveredAt = at;
    message.via = via;
    // pushProgress scrubs the owner's secrets out of the line and caps it,
    // like every other step in the feed.
    pushProgress(run, runMessageProgressLine(message.text, via));
    marked += 1;
  }
  // At once, not debounced: a mark that died with the process would deliver
  // the message a second time at the next spawn.
  if (marked > 0) persist(true);
}

/** Different paths one spawn is pointed at before the box stops saying it: a run that keeps missing its folder is told a few times, not thirty. */
const MAX_WORKTREE_HINTS = 3;

/**
 * Answer a refusal on the project's own path, met by a run working in a
 * worktree, with where that path is in its folder (coding-worktree-paths.ts):
 * the box's own note, put on the record and written to the streaming harness
 * at once — the road the owner's messages take, so it is on the record, in
 * the feed, and in the run's transcript as its next user turn (framed as the
 * box's by runMessageTurn). The refusal itself stands; this only says where
 * to retry. Once per path per spawn, a few paths at most, and only to a
 * harness that takes it NOW: queued for a later spawn it would sit in the
 * owner's queue and say where to retry after the work was over.
 *
 * `flush` false leaves it queued for the turn's end (a result event): there
 * `afterTurn` delivers it, and a turn it delivered something to keeps the
 * pipe open — written here, afterTurn would find the queue empty and close
 * stdin behind it, and a message sent while the run acted on the hint could
 * no longer reach it.
 */
function hintWorktree(run: CodingRun, state: LiveRun, tool: string, counterpart: string, flush = true): void {
  if (!(state.midTurn && state.turnOpen) && !(state.streamInput && state.stdinOpen)) return;
  if (state.worktreeHinted.has(counterpart) || state.worktreeHinted.size >= MAX_WORKTREE_HINTS) return;
  state.worktreeHinted.add(counterpart);
  try {
    // Marked as the box's by the runner itself — never by what the text says.
    run.messages = appendRunMessage(run.messages, normalizeRunMessage(worktreeHintText(tool, run.directory, counterpart)), Date.now(), "box");
  } catch {
    // The queue is full, or the path is not plain text: no hint, the refusal stands as it is.
    return;
  }
  persist(true);
  if (flush) deliverRunMessages(run, state);
}

/**
 * Write every message still queued on this run to a live STREAMING harness, as
 * its next user turn(s), and answer how many went.
 *
 * A no-op on a run whose stdin this process does not hold — a plain spawn, one
 * reattached after a restart, or one whose harness has already been told to
 * finish. Those queues ride out with the next spawn's own stdin instead, which
 * is why nothing here is an error.
 */
function flushRunMessages(run: CodingRun, state: LiveRun): number {
  const stdin = state.child?.stdin;
  if (!state.streamInput || !state.stdinOpen || !stdin || stdin.destroyed || stdin.writableEnded) return 0;
  const waiting = queuedMessages(run.messages);
  if (!waiting.length) return 0;
  const sent: RunMessage[] = [];
  for (const message of waiting) {
    try {
      stdin.write(streamJsonUserTurn(runMessageTurn(message.text, message.from)));
    } catch {
      // The pipe went while we were writing. What is left stays queued, which
      // is the honest record: the harness did not get it.
      state.stdinOpen = false;
      break;
    }
    sent.push(message);
  }
  // Marked only once the bytes are on the pipe — "delivered" is a claim the
  // owner reads, and a message still in the queue is one the box owes them.
  noteMessagesDelivered(run, sent, "next_turn");
  if (sent.length) state.turnOpen = true;
  return sent.length;
}

/**
 * Hand what is queued to the run the quickest way it has NOW: its inbox while
 * a turn is under way and the spawn has the hook (after the tool call it is
 * in), else its stdin as the next turn. Answers how the queue went.
 */
function deliverRunMessages(run: CodingRun, state: LiveRun): RunMessageDelivery {
  if (state.midTurn && state.turnOpen && postQueuedToInbox(run, state) > 0) return "after_tool_call";
  if (state.midTurn && state.turnOpen && state.inboxPosted.size > 0) return "after_tool_call";
  return flushRunMessages(run, state) > 0 ? "delivered" : "next_start";
}

/** The spawn's `--settings` hooks, or null when the hook script is not in this checkout. */
function spawnHookSettings(run: CodingRun): { json: string; inbox: boolean } | null {
  const script = runHookScriptPath();
  if (!fs.existsSync(script)) return null;
  let inbox: string | null = null;
  try {
    inbox = ensureRunInbox(run.id);
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: no inbox:`, err instanceof Error ? err.message : err);
  }
  const json = runHookSettings({ node: process.execPath, script, inbox, mergeGuard: run.team !== null && !run.readOnly });
  return json ? { json, inbox: inbox !== null } : null;
}

/** The ids waiting in a run's inbox; none for an inbox that cannot be read. */
function safeInboxPending(runId: string): string[] {
  try {
    return inboxPending(runId);
  } catch {
    return [];
  }
}

/**
 * Put every queued message this process has not put in the inbox yet there,
 * framed the way the harness reads a message (runMessageTurn). Answers how
 * many went in; a write that failed leaves its message queued.
 */
function postQueuedToInbox(run: CodingRun, state: LiveRun): number {
  let posted = 0;
  for (const message of queuedMessages(run.messages)) {
    if (state.inboxPosted.has(message.id)) continue;
    if (!postToInbox(run.id, { id: message.id, at: message.at, context: runMessageTurn(message.text, message.from) })) break;
    state.inboxPosted.add(message.id);
    posted += 1;
  }
  return posted;
}

/**
 * What the run's hook handed over since the last look: marked delivered,
 * mid-turn, at the moment the hook took it, and said on the run's feed — then
 * the receipts go. Called from the tail while anything is in the inbox, and
 * on the way into a settle.
 */
function collectInboxReceipts(run: CodingRun, state: LiveRun | null): number {
  let receipts: Array<{ id: string; at: number }>;
  try {
    receipts = inboxReceipts(run.id);
  } catch {
    return 0;
  }
  if (!receipts.length) return 0;
  let marked = 0;
  for (const receipt of receipts) {
    state?.inboxPosted.delete(receipt.id);
    const message = run.messages.find((m) => m.id === receipt.id);
    if (!message || message.deliveredAt !== null) continue;
    noteMessagesDelivered(run, [message], "mid_turn", receipt.at);
    marked += 1;
  }
  // Recorded (persisted at once by noteMessagesDelivered) before the receipt
  // goes: a receipt outlives a crash in between, a lost mark would not.
  clearReceipts(run.id, receipts.map((r) => r.id));
  return marked;
}

/**
 * The hook can only hand a message over while a turn is going. At a turn's
 * end, a settle, and before a spawn delivers the queue its own way, whatever
 * it took is recorded and whatever it did not is taken BACK — still queued on
 * the record, for the next turn or the next start. One rename decides between
 * the hook and this, so a message is never both.
 */
function settleRunInbox(run: CodingRun, state: LiveRun | null): void {
  try {
    collectInboxReceipts(run, state);
    reclaimInbox(run.id);
    // A receipt the hook wrote between the two looks.
    collectInboxReceipts(run, state);
  } catch {
    // An inbox that cannot be read holds nothing the record does not.
  }
  state?.inboxPosted.clear();
}

/**
 * A turn has ended and the CLI is waiting for more input.
 *
 * Either give it what is queued — the point of the whole feature — or close
 * its stdin, which is what makes a streaming harness exit so the run can
 * settle. Closing is safe at any turn: a plain spawn has had its stdin closed
 * since the first byte and still runs its extra segments when a background
 * helper reports, so EOF is not what ends the process — waiting for input is.
 */
function afterTurn(run: CodingRun, state: LiveRun): void {
  if (!state.streamInput || !state.stdinOpen) return;
  // The turn is over, so the hook will not run again until the next one:
  // what it did not take goes as that next turn instead.
  state.turnOpen = false;
  settleRunInbox(run, state);
  if (flushRunMessages(run, state) > 0) return;
  closeRunStdin(state);
}

/** Let the harness know nothing more is coming. Idempotent. */
function closeRunStdin(state: LiveRun): void {
  if (!state.stdinOpen) return;
  state.stdinOpen = false;
  try {
    state.child?.stdin?.end();
  } catch {
    // The child is already gone; its exit is what reports that.
  }
}

// ─── A run's own copy of the project ─────────────────────────────────────────

/** The ClawBox checkout: never forked, never branched, by a run. DATA_DIR is <clawbox>/data. */
function protectedCheckout(): string {
  return path.dirname(DATA_DIR);
}

/**
 * Give this run a working tree of its own, and move it in.
 *
 * Called before the record is inserted, so the record that reaches disk names
 * the folder the run will actually work in — nothing ever sees a run whose
 * `directory` is the project while its process is in the worktree.
 *
 * A refusal is NOT a failure: three of the four reasons are folders that
 * deliberately keep the old in-place behaviour (see coding-run-worktree.ts),
 * and even the fourth — git could not do it — leaves a perfectly good run
 * working in its project folder, which is what every run did until now. Only
 * that fourth is said on the record, because it is the only one the owner
 * could act on.
 */
async function attachRunWorktree(run: CodingRun, projectDir: string): Promise<void> {
  // Never throws: a run that could not be given a copy of the project is a
  // run working in the project folder, which is what every run did until now
  // — not a run that fails to start.
  const made = await addRunWorktree({ projectDir, runId: run.id, protectedRoot: protectedCheckout() })
    .catch((err: unknown) => ({ ok: false as const, reason: "failed" as const, detail: err instanceof Error ? err.message : String(err) }));
  if (!made.ok) {
    if (made.reason === "failed") pushProgress(run, RUNNER_STEP.worktreeKept(`it could not be made — ${made.detail}`));
    return;
  }
  run.worktree = { path: made.path, branch: made.branch, base: made.base, project: projectDir, removed: false, branchRemoved: false, result: null };
  run.directory = made.path;
  pushProgress(run, RUNNER_STEP.worktree(made.branch, made.base));
}

/**
 * The worktree a resumed run carries forward, put back on disk if a settle
 * took it away.
 *
 * Answers the record the NEW run should carry, which is the same worktree
 * with `removed` recomputed. A restore that fails answers the record
 * unchanged rather than throwing: `realDirectory` is the next thing the
 * caller does, and its refusal ("the folder this run worked in is gone") is
 * the sentence the owner needs — not a git error out of a repair they never
 * asked for.
 */
async function reopenWorktree(previous: CodingRun): Promise<RunWorktree | null> {
  const wt = previous.worktree;
  if (!wt) return null;
  const back = await restoreRunWorktree(wt.project, wt.path, wt.branch, wt.base).catch(() => false);
  // A restore re-creates the branch when a settle had dropped an empty one, so
  // a copy that is back has its branch back with it. The merge verdict goes:
  // it described a chain that had ENDED, and this run is about to work in the
  // tree again — an "it could not be merged, the project is dirty" carried
  // forward would have the card offer a next step for a run still going.
  return { ...wt, removed: !back, branchRemoved: back ? false : wt.branchRemoved, result: null };
}

/** Every live run working in this exact folder — the question "is anybody still in there?". */
function liveRunsIn(directory: string): CodingRun[] {
  return loadRuns().filter((r) => isLive(r.status) && r.directory === directory);
}

/**
 * What becomes of the run's worktree now that the chain it belongs to is over.
 *
 * THE RULE (the owner's, 2026-10-12): once the chain is over, the FILES go
 * and the BRANCH stays. A run's work is its commits, and a worktree is only a
 * checkout of them — git puts it back from the branch in a second when a
 * resume, a review round or a Fix CI continuation needs it (`reopenWorktree`
 * → `restoreRunWorktree`). Until this rule the tree stayed whenever the merge
 * home was refused, and on a box whose owner keeps any uncommitted change in
 * a project folder that is EVERY run: one project had ten copies of itself,
 * 617 MB, under `.clawbox/worktrees/`, each one the files of a branch that
 * was already safe in git. The old exception for a pull request (keep the
 * tree, the review loop works in it) goes for the same reason — the loop's
 * continuation is a `startRun({ resumeRunId })`, which restores the tree.
 *
 * In order:
 *   - somebody is still working in it (the automatic review pass, another go
 *     at the deliverable, the owner's own Resume) — leave it alone;
 *   - a live DELIVERY PIPELINE owns the run — leave it alone too. Between
 *     stages it holds no live run at all, and the copy is what the improvement
 *     lap re-spawns into and what an upload deploy sends; `settlePipelineRun`
 *     comes back here when the chain is actually over;
 *   - the branch holds nothing — remove the tree AND the branch, which is
 *     the common ending for a run that investigated and changed nothing;
 *   - a pull request owns the branch — remove the tree, keep the branch: the
 *     work goes home through the request, and a local merge would take the
 *     commits away from it;
 *   - otherwise merge it home into the project's base branch and remove the
 *     tree. A merge the project cannot take (it moved, it is dirty, it
 *     conflicts) is RECORDED on the run so the page can say which, and the
 *     tree still goes — the work is on the branch, where the Changes tab and
 *     `git merge` both find it.
 *
 * Only three things keep a tree on disk now: git could not say what is on its
 * branch (no answer is not permission to delete), the tree holds work its
 * branch does not (`unsavedWork` below), or the removal itself failed — and
 * those are what the page's Remove copy is for.
 *
 * Never throws: this is the settle path, and a run whose tree could not be
 * tidied is still a run that finished.
 */
async function settleRunWorktree(run: CodingRun): Promise<void> {
  const wt = run.worktree;
  if (!wt || wt.removed) return;
  try {
    if (liveRunsIn(wt.path).length > 0) return;
    if (pipelineOwnsRun(run)) return;
    if (!fs.existsSync(wt.path)) {
      wt.removed = true;
      persist(true);
      return;
    }
    const ahead = await commitsAhead(wt.project, wt.branch, wt.base);
    if (ahead === null) {
      // No answer is not permission to delete: keep it and say so.
      pushProgress(run, RUNNER_STEP.worktreeKept("git could not say what is on its branch"));
      persist(true);
      return;
    }
    // Asked before EVERY removal below. `commitsAhead` counts the branch only,
    // and `removeRunWorktree` forces: a commit that failed after its
    // `git add -A` leaves the work staged in the tree, and a run that wrote
    // through its shell without committing leaves it untracked there. Either
    // way the tree is the only copy, so it stays — as it does when git cannot
    // say. The answer is why it stays, or null when nothing would be lost.
    const unsavedWork = async (): Promise<string | null> => {
      if (run.commitError) return "the run's commit failed, so it may hold work its branch does not";
      const changed = await worktreeHasChanges(wt.path);
      if (changed === null) return "git could not say whether it holds uncommitted changes";
      return changed ? "it holds changes that are not committed to its branch" : null;
    };
    if (ahead === 0) {
      const unsaved = await unsavedWork();
      if (unsaved) {
        pushProgress(run, RUNNER_STEP.worktreeKept(unsaved));
        persist(true);
        return;
      }
      // Recorded only if the files are actually gone: git can refuse the
      // removal (a busy file, an index lock), and a record that claimed the
      // copy had gone would leave the disk unreclaimed with nothing to retry
      // from — the owner's Remove returns early on exactly that flag.
      if (!(await removeRunWorktree(wt.project, wt.path))) {
        pushProgress(run, RUNNER_STEP.worktreeKept("it could not be removed"));
        persist(true);
        return;
      }
      // An empty branch is not history; a branch per run that changed nothing
      // would be the box leaving litter in the owner's repository.
      await deleteRunBranch(wt.project, wt.branch);
      wt.removed = true;
      wt.branchRemoved = true;
      pushProgress(run, RUNNER_STEP.worktreeRemoved);
      persist(true);
      return;
    }
    // The files go either way from here, unless they hold unsaved work; only
    // the SENTENCE differs. Recorded only if they are actually gone (see the
    // `ahead === 0` branch above).
    const park = async (reason: string): Promise<void> => {
      const unsaved = await unsavedWork();
      if (unsaved) {
        pushProgress(run, RUNNER_STEP.worktreeKept(`${unsaved}; ${reason}`));
        persist(true);
        return;
      }
      if (!(await removeRunWorktree(wt.project, wt.path))) {
        pushProgress(run, RUNNER_STEP.worktreeKept(`${reason}, and the copy could not be removed`));
        persist(true);
        return;
      }
      wt.removed = true;
      pushProgress(run, RUNNER_STEP.worktreeParked(wt.branch, reason));
      persist(true);
    };
    if (run.pr && run.pr.phase !== "failed") {
      await park("it is open as a pull request");
      return;
    }
    const merged = await mergeRunBranch({
      projectDir: wt.project,
      branch: wt.branch,
      base: wt.base,
      message: `Coding agent ${run.id}: ${taskTitle(run.task, 72)}`,
    });
    if (!merged.ok) {
      // Recorded, not just logged: this is the state the run's page reads to
      // say the work is on the branch and why it is not in the project.
      wt.result = { kind: "unmerged", reason: merged.reason, detail: merged.detail, base: null, commit: null };
      await park(merged.detail);
      return;
    }
    wt.result = { kind: "merged", reason: null, detail: null, base: wt.base, commit: merged.commit };
    // The merge took the branch home, not what the tree holds beside it.
    const unsaved = await unsavedWork();
    if (unsaved) {
      pushProgress(run, RUNNER_STEP.worktreeKept(`it was merged into ${wt.base}, but ${unsaved}`));
      persist(true);
      return;
    }
    if (!(await removeRunWorktree(wt.project, wt.path))) {
      // The work IS home — the merge landed — so this is only the copy left
      // behind, and the card's Remove is what answers it.
      pushProgress(run, RUNNER_STEP.worktreeKept(`it was merged into ${wt.base} but could not be removed`));
      persist(true);
      return;
    }
    wt.removed = true;
    pushProgress(run, RUNNER_STEP.worktreeMerged(wt.base));
    persist(true);
  } catch (err) {
    console.error(`[coding-agent] ${run.id} worktree settle:`, err instanceof Error ? err.message : err);
  }
}

/**
 * The owner's Remove worktree button: take the files away whatever is on the
 * branch.
 *
 * Deliberately keeps the BRANCH. The button exists for a tree the settle
 * could not remove, which by definition holds commits nothing else has —
 * removing the files is reclaiming disk, and deleting the commits with them
 * would be a different, unrecoverable act behind the same word.
 */
export async function removeRunWorktreeFor(id: string): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  const wt = run.worktree;
  if (!wt) throw new CodingAgentError("invalid", "That run worked in the project folder itself, so there is no copy to remove.");
  if (isLive(run.status) || liveRunsIn(wt.path).length > 0) {
    throw new CodingAgentError("busy", "A run is still working in that copy of the project. Stop it first.");
  }
  if (!wt.removed) {
    let gone: boolean;
    try {
      gone = await removeRunWorktree(wt.project, wt.path);
    } catch (err) {
      throw new CodingAgentError("invalid", `Could not remove the run's copy of the project: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Refused rather than recorded: this call returns early on `removed`, so a
    // record written on git's word alone would make the button a no-op over a
    // copy still sitting on the disk.
    if (!gone) {
      throw new CodingAgentError("invalid", `Could not remove the run's copy of the project (${wt.path}). Something may still be using it.`);
    }
  }
  wt.removed = true;
  pushProgress(run, RUNNER_STEP.worktreeKept(`the owner removed the files; ${wt.branch} still has its commits`));
  persist(true);
  return cloneRun(run);
}

/** How often the box looks for worktrees nothing needs any more. */
export const WORKTREE_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const WORKTREE_SWEEP_AT_KEY = "coding_agent_worktree_swept_at";

/**
 * The weekly sweep: worktrees older than a fortnight whose branch is merged
 * or gone, across every project a known run has one in.
 *
 * WHY IT IS NEEDED at all, when the settle already tidies up: a run whose
 * merge conflicted, a box that restarted mid-settle, a project the owner
 * rebased by hand — each leaves a tree the settle never got to. Fourteen days
 * of no-one-touched-it plus a merged-or-gone branch is the point at which the
 * files are certainly recoverable from git.
 *
 * At most weekly (`WORKTREE_SWEEP_AT_KEY` in the config store), because the
 * web server restarts far more often than that and a sweep per boot would be
 * a `git worktree list` per project on every one. Never throws, and never
 * touches a tree a live run is in.
 */
export async function sweepCodingWorktrees(options: { force?: boolean } = {}): Promise<number> {
  try {
    if (!options.force) {
      const last = await configGet(WORKTREE_SWEEP_AT_KEY);
      if (typeof last === "number" && Date.now() - last < WORKTREE_SWEEP_INTERVAL_MS) return 0;
    }
    const runs = loadRuns();
    const projects = new Set<string>();
    for (const run of runs) {
      if (run.worktree) projects.add(run.worktree.project);
    }
    if (projects.size === 0) {
      await configSet(WORKTREE_SWEEP_AT_KEY, Date.now());
      return 0;
    }
    const inUse = new Set(runs.filter((r) => isLive(r.status)).map((r) => r.directory));
    let removed = 0;
    for (const project of projects) {
      try {
        const outcome = await sweepRunWorktrees(project, { inUse });
        removed += outcome.removed.length;
        // A record whose tree the sweep took must not go on claiming one, or
        // a resume would try to work in a folder that is not there.
        for (const gone of outcome.removed) {
          for (const run of runs) {
            if (run.worktree && run.worktree.path === gone) run.worktree.removed = true;
          }
        }
      } catch (err) {
        console.warn(`[coding-agent] worktree sweep of ${project} failed:`, err instanceof Error ? err.message : err);
      }
    }
    if (removed > 0) persist(true);
    await configSet(WORKTREE_SWEEP_AT_KEY, Date.now());
    return removed;
  } catch (err) {
    console.error("[coding-agent] worktree sweep:", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ─── Public operations ───────────────────────────────────────────────────────

export async function startRun(input: StartRunInput): Promise<CodingRun> {
  let task = normalizeTask(input.task, isBoxWrittenTask(input));
  /** A Fix CI continuation's place in its chain — see StartRunInput.fixCi. */
  let ciFixOf: { runId: string; attempt: number } | null = null;
  // Read before anything is held — the slot, the folder — so a malformed
  // request is a plain 400 that cost the box nothing.
  const givenExperience = requireExperience(input.experience);

  let resumeSessionId: string | null = null;
  let directory: string;
  let projectId: string | null;
  /**
   * A resume carries the earlier run's account forward unless the caller says
   * otherwise: the session it re-enters was opened on that credential and with
   * that model, and moving it to whatever the owner's default has since become
   * would continue somebody else's conversation on a stranger's bill.
   */
  let inherited: { provider: CodingProvider; model: string | null } | null = null;
  /**
   * The worktree a resumed run carries forward. It belongs to the CHAIN, not
   * to one record: the automatic review pass and a review-loop turn are fresh
   * records resuming the same session in the same tree, and whichever of them
   * settles last is the one that has to decide what becomes of it.
   */
  let inheritedWorktree: RunWorktree | null = null;

  const resumeRunId = typeof input.resumeRunId === "string" ? input.resumeRunId.trim() : "";
  const previous = resumeRunId ? loadRuns().find((r) => r.id === resumeRunId) ?? null : null;

  // WHICH ACCOUNT THIS RUN WILL USE, worked out before the spawn gate rather
  // than after it. The gate judges a provider's credential, and judging the
  // owner's DEFAULT would refuse a run that explicitly named the account that
  // works — with a sentence about the account it never asked for. The caller's
  // choice, else the run being resumed, else — for a team's fresh run — its
  // role's, else the owner's default; the order applyProviderChoice and the
  // role step apply below, which have the last word.
  const modelRole = input.team ? modelRoleOf(input.team.role, input.team.bulk === true) : null;
  const intendedProvider = isCodingProvider(input.provider)
    ? input.provider
    : previous?.provider ?? await ownerOrRoleProvider(modelRole);
  // The slot is HELD from the gate to the insert below. `assertCanSpawn` counts
  // the runs it can see, and `loadRuns()` cannot see this one until
  // `insertRun` — several awaits away (the spawn tools, the folder, the
  // settings, the worktree, the auto-PR read) — so two starts that arrive
  // together both saw room for one. The same answer `teamSpawnSlot` already
  // gives with its `starting` count.
  const releaseSlot = await assertCanSpawn(input.team ?? null, intendedProvider, !input.team && typeof input.reviewOf === "string");
  // Held beside the slot, and for the same span and the same reason: the folder
  // this run is starting in is claimed the moment `assertDirectoryFree` passes
  // and let go only once the record is visible, so a removal cannot slip
  // between the two. Reassigned rather than awaited into, because which branch
  // below resolves the folder depends on whether this is a resume.
  let releaseDirectory: () => void = () => {};
  try {
    const tools = await requireSpawnTools();

    if (resumeRunId) {
      if (!previous) throw new CodingAgentError("not_found", "There is no coding run with that id to resume.");
      if (previous.status === "running") throw new CodingAgentError("busy", "That run is still in progress; wait for it to finish before resuming it.");
      // A caller asking for a FRESH session is not asking to resume: it wants
      // the chain — the folder, the worktree and its branch, the project, the
      // provider and the model — and has already decided the session is gone.
      // See StartRunInput.freshSession; the review loop's fallback is the only
      // caller, and without this exemption a round over a run that never
      // opened a session is refused rather than done cold.
      if (!previous.sessionId && input.freshSession !== true) {
        throw new CodingAgentError("invalid", `That run never started a ${runsOnCodex(previous.provider) ? "Codex" : "Claude Code"} session, so it cannot be resumed. Start a new run instead.`);
      }
      // Fix CI: what failed goes after the caller's words — the box's own text
      // from GitHub's logs, clipped the way a box-written task is.
      if (input.fixCi === true) {
        ciFixOf = { runId: previous.id, attempt: ciFixAttempt(previous, input.queuedRunId ?? null) };
        task = normalizeTask(`${task}\n\n${ciFixNotes(previous.ci!, { push: true })}`, true);
      }
      // The session lives in the wrapper's state dir keyed by the folder it ran
      // in, so a resume always happens where the original run happened — which
      // for a run with a worktree is the worktree. A settle removes the worktree
      // of a run that left nothing on its branch, so it is put back from that
      // branch first; the tree is the only thing that was removed.
      inheritedWorktree = await reopenWorktree(previous);
      directory = await realDirectory(previous.directory);
      releaseDirectory = assertDirectoryFree(directory, undefined, input.team ?? null, input.readOnly === true);
      projectId = previous.projectId;
      // A session poisoned by an authentication or transport failure REPLAYS
      // that failure on every resume — Claude Code persists it in the session,
      // so resuming is a re-enactment, not a retry. Measured on a real box: a
      // transient upstream error at 09:01 was resumed at 09:05 into the same
      // session and failed identically, which is how a passing cloud hiccup
      // became a permanently broken project.
      //
      // So the work carries on in a FRESH session instead. The task text is the
      // caller's and says what to continue; what is lost is the old
      // conversation, which was worthless anyway — it contains one failed
      // request. Refusing outright would be worse: it would leave the owner
      // with a project that can never be resumed.
      // A COMPLETED session is also safe to continue — it is not poisoned, it
      // simply finished — and continuing it is what carries the built-up context
      // into a follow-up ("fix these review findings", the automatic review
      // pass). A stopped run, or a failure that is not a ceiling, starts fresh.
      resumeSessionId = input.freshSession === true
        ? null
        : previous.resumable || previous.status === "completed" ? previous.sessionId : null;
      inherited = { provider: previous.provider, model: previous.requestedModel };
    } else {
      if (input.fixCi === true) throw new CodingAgentError("invalid", "A Fix CI run continues the run whose pull request failed: name it in resumeRunId.");
      ({ directory, projectId } = await resolveWorkingDirectory(input));
      releaseDirectory = assertDirectoryFree(directory, undefined, input.team ?? null, input.readOnly === true);
    }

    // Read once, here: a run keeps the settings it started with even if the
    // owner changes them while it works.
    const settings = await applyProviderChoice(await readRunSettings(), input, inherited);
    // A REVIEW ROUND inherits the effort of the run it is fixing, the way it
    // already inherits that run's provider and model. A round is a
    // continuation, not a new piece of work: thinking harder or softer about
    // the fix than about the code being fixed is a difference nobody asked for,
    // and on the fresh path — where the run has no memory to lean on — the
    // owner's current setting could be the weaker of the two.
    if (previous && typeof input.reviewLoopOf === "string") settings.effort = previous.effort;
    // Every continuation — a resume, the review pass, a review round, a Fix CI
    // — keeps the diet the work was started under (CodingRun.diet): the same
    // session re-read with a different brief would lose the provider's prefix
    // cache, and the tools it holds would move under it.
    if (previous) settings.diet = previous.diet;
    // A TEAM's run gets its role's model and effort (src/lib/coding-role-models.ts):
    // a planner, a lead and a reviewer the provider's cheaper model and at most
    // `xhigh` unless the owner chose otherwise; a worker the owner's own, and a
    // worker on a bulk task the `bulk` role's. A role the owner put on another
    // provider moves there, model and all — the readiness check below is that
    // provider's, and the spawn's environment and credential are that
    // provider's alone (buildRunEnv, prepareRunAccount: both read the record).
    // A resume — a review round included — keeps the provider and model its
    // session was opened on (applyProviderChoice already carried them) and
    // takes only the effort.
    if (modelRole) {
      const role = resolveRoleRun(modelRole, settings.provider, settings.model, settings.effort, await getRoleModels());
      settings.effort = role.effort;
      if (!inherited) {
        settings.provider = role.provider;
        settings.model = role.model;
      }
    }
    await assertProviderReady(settings.provider);
    // A resume carries the lessons of the run it continues, the way it carries
    // that run's account and folder — the automatic review pass and every
    // review-loop round included — unless the caller sent a block of its own.
    const experience = givenExperience
      ?? (previous ? { brief: previous.experienceBrief ?? null, record: previous.experience ?? null } : null);
    const queuedRunId = typeof input.queuedRunId === "string" ? input.queuedRunId : null;
    // This run's share of the CPU (src/lib/coding-run-cpu.ts): the runs that
    // write going now, this one, and the siblings a team means to start beside
    // it, whichever is more. A read-only run runs no build and is not counted.
    const writersLive = loadRuns().filter((r) => isLive(r.status) && !r.readOnly && r.id !== queuedRunId).length;
    const cpuShare = typeof input.cpuShare === "number" && Number.isFinite(input.cpuShare) && input.cpuShare >= 1 ? Math.floor(input.cpuShare) : 1;
    const cpuBudget = runCpuBudget({ cpus: hostCpuCount(), concurrent: Math.max(cpuShare, writersLive + 1), onBattery: await onBatteryPower() });
    const run = newRunRecord({
      ...(queuedRunId ? { id: queuedRunId } : {}),
      task,
      directory,
      projectId,
      source: input.source,
      status: "running",
      settings,
      deliverable: requireDeliverable(input),
      reviewOf: typeof input.reviewOf === "string" ? input.reviewOf : null,
      reviewLoopOf: typeof input.reviewLoopOf === "string" ? input.reviewLoopOf : null,
      reviewRound: typeof input.reviewRound === "number" && input.reviewRound > 0 ? Math.floor(input.reviewRound) : null,
      team: input.team ?? null,
      modelRole,
      readOnly: input.readOnly === true,
      extraBrief: typeof input.extraBrief === "string" && input.extraBrief.trim() ? input.extraBrief.trim() : null,
      cpuBudget,
      experience: experience?.record ?? null,
      experienceBrief: experience?.brief ?? null,
    });
    // THE FILES THIS RUN WAS GIVEN, staged before anything else: the task
    // context names the folder, so what is in it has to be true by the time the
    // harness reads that line. Never fatal — an asset that could not be copied
    // is reported to the run (and drawn on its page) rather than losing the
    // task it was an input to.
    // A continuation of a run that HAD the visual tools keeps them, so its
    // session's tools and prompt prefix stay what they were; one that did not
    // is decided afresh at its first spawn, from its own task and the folder
    // as it is then (a review pass over pages the run just wrote gets them).
    if (previous?.visual === true) run.visual = true;
    await stageInputs(run, input.inputs);
    if (ciFixOf) {
      run.ciFixOf = ciFixOf;
      pushProgress(run, RUNNER_STEP.ciFix(ciFixOf.runId, ciFixOf.attempt, MAX_CI_FIX_ATTEMPTS));
    }
    if (run.reviewOf) pushProgress(run, RUNNER_STEP.reviewPass(run.reviewOf));
    else if (run.reviewLoopOf) pushProgress(run, RUNNER_STEP.reviewLoopTurn(run.reviewLoopOf, run.reviewRound));
    else if (resumeSessionId) pushProgress(run, RUNNER_STEP.resuming);
    else if (resumeRunId) pushProgress(run, RUNNER_STEP.startingFresh(resumeRunId));

    // THE RUN'S OWN COPY OF THE PROJECT, before anything else touches the
    // folder. A resume carries the previous run's forward — same tree, same
    // branch, same session — and a team's worker already has one the team made.
    // A read-only run (the team's planner) reads the project itself: it writes
    // nothing, so there is nothing to isolate, and a worktree would only hide
    // the folder it was asked to look at.
    if (resumeRunId) {
      run.worktree = inheritedWorktree;
    } else if (!run.team && !run.readOnly) {
      await attachRunWorktree(run, directory);
    }

    // The run's own branch, made BEFORE any work happens.
    //
    // This is the only simple moment for it: commitRunWork commits to whatever
    // branch is checked out, so branching first puts the commits where a pull
    // request needs them and no history has to be rewritten afterwards. A review
    // pass is deliberately excluded — it resumes in the same folder and belongs
    // on the same branch, which it is already on.
    // A team's run is excluded too: a worker already sits on its own branch
    // in its own worktree (coding-team-worktree.ts), and a second branch
    // under it would take the commits away from the merge the team makes.
    // A review-loop turn is excluded for the reason a review pass is: it resumes
    // in the same folder, on the branch its own pull request is already open
    // from, and a second branch under it would take the fixes away from that
    // pull request.
    if (!run.reviewOf && !run.reviewLoopOf && !run.readOnly && !run.team && (await getAutoPr())) {
      if (run.worktree) {
        // The worktree IS the branch: `git worktree add -b clawbox/<runId>` has
        // already forked it, off the project's own branch, and the run is
        // standing in it. Calling startRunBranch here would `checkout -b` a
        // SECOND branch of the same name — in the worktree, where it would
        // fail, or in the project checkout, which is precisely the move that
        // cannot happen once two runs share a repository.
        const { branch, base } = run.worktree;
        run.pr = {
          phase: "opening",
          number: null,
          url: null,
          branch,
          base,
          checks: emptyChecks(),
          detail: null,
          startedAt: Date.now(),
          endedAt: null,
          reviewOk: true,
          // Nothing has been found or opened yet — see PrFoundBy.
          foundBy: null,
        };
        pushProgress(run, RUNNER_STEP.workingOnBranch(branch, base));
      } else {
        const branched = await startRunBranch({
          directory: run.directory,
          runId: run.id,
          // DATA_DIR is <clawbox>/data, so its parent is the checkout a run must
          // never branch — see startRunBranch.
          protectedRoot: path.dirname(DATA_DIR),
        });
        if (!branched.ok && branched.reason === "no_repository") {
          // Not a failure of the flow — there is no repository for a branch to
          // live in yet. The settle makes one and commits into it
          // (commitRunWork); a pull request needs a remote the owner adds later
          // through Back up. Stamping this "failed" with git's raw fatal put a
          // red line at the top of every fresh-folder run in bench cycle 1.
          run.pr = null;
          pushProgress(run, RUNNER_STEP.noRepository);
        } else if (branched.ok) {
          run.pr = {
            phase: "opening",
            number: null,
            url: null,
            branch: branched.branch,
            base: branched.base,
            checks: emptyChecks(),
            detail: null,
            startedAt: Date.now(),
            endedAt: null,
            // No verdict yet; the one that counts is written when the pull
            // request opens, which is the only way into "waiting".
            reviewOk: true,
            foundBy: null,
          };
          pushProgress(run, RUNNER_STEP.workingOnBranch(branched.branch, branched.base));
        } else {
          // Not fatal: the work is worth doing on whatever branch this is. The
          // owner is told why there will be no pull request.
          run.pr = {
            phase: "failed",
            number: null,
            url: null,
            branch: null,
            base: null,
            checks: emptyChecks(),
            detail: branched.detail,
            startedAt: Date.now(),
            endedAt: Date.now(),
            reviewOk: false,
            foundBy: null,
          };
          pushProgress(run, RUNNER_STEP.noPullRequest(branched.detail));
        }
      }
    }

    // After the branch, because the auto-PR switch is what gives a run with no
    // named deliverable an implied one, and `run.pr` is only set above. An
    // attempt entry exists exactly for a run that HAS a bar to clear, so a run
    // without one never grows the list.
    openAttempt(run);

    // THE DELIVERY PIPELINE. Last, because it reads the branch and the project
    // this run ended up in, and because its preflight reads the project — a call
    // that must not sit between the spawn gate and the folder checks.
    await attachPipeline(run, input, settings);

    // Before the record is persisted, so the names and the two progress lines are
    // in the first thing the app reads rather than appearing a poll later.
    await prepareRunSecrets(run);
    // A start refused between here and the insert never reaches a settle, so it
    // gives back what it was just handed: the values out of memory, and the
    // one-run copies it claimed back out of the store.
    const abandon = (err: unknown): never => {
      dropRunSecrets(run.id);
      endRunSecrets(run);
      throw err;
    };
    // Read before the insert, never between it and the write: the insert and
    // persist are one synchronous step (see the runs store).
    const history = await getHistoryPolicy().catch(abandon);
    const list = loadRuns();
    // A QUEUED run's turn: this record takes the queued one's place, with what
    // it was told while it waited and the steps it already showed — never a
    // second row beside it. Gone from the queue meanwhile (the owner canceled
    // it while this start was on its way), it does not start at all.
    const waited = queuedRunId ? list.findIndex((r) => r.id === queuedRunId) : -1;
    if (queuedRunId && (waited < 0 || list[waited].status !== "queued")) {
      abandon(new CodingAgentError("invalid", "That queued run is no longer waiting: it was canceled or has already started."));
    }
    // The failure it fixes now names it, so it is never offered twice.
    if (ciFixOf && previous?.ci) previous.ci = { ...previous.ci, fixRunId: run.id };
    if (waited >= 0) {
      const before = list[waited];
      run.messages = before.messages;
      run.progress = [...before.progress, ...run.progress];
      run.progressAt = [...before.progressAt, ...run.progressAt];
      pushProgress(run, RUNNER_STEP.startedFromQueue);
      list[waited] = run;
    } else {
      insertRun(list, run, history);
    }
    persist(true);
    console.error(`[coding-agent] ${run.id} started by ${run.source} in ${run.directory}${waited >= 0 ? " from the queue" : ""}`);
    startProjectIcon(run);
    try {
      spawnOrSettle(run, resumeSessionId, tools, settings);
    } catch (err) {
      // It never started, so the failure it claimed is free again (the
      // queued path's releaseCiClaim, for a start that throws here).
      if (ciFixOf && previous?.ci?.fixRunId === run.id) {
        previous.ci = { ...previous.ci, fixRunId: null };
        persist(true);
      }
      throw err;
    }
    return cloneRun(run);
  } finally {
    releaseDirectory();
    releaseSlot();
  }
}

/**
 * Copy the assets this run was handed into a folder it may read, and record
 * what landed there.
 *
 * The inputs FOLDER is made whatever the caller named, including nothing at
 * all: it is what the owner is shown as "inputs for this run", and it is where
 * they are told to put a file the run turns out to need. Only the copying is
 * conditional.
 *
 * Never throws. An asset the box could not stage is a fact on the record (and
 * a sentence in the run's own first turn), not a reason to refuse a task the
 * rest of which is perfectly doable — the failure this whole thing exists to
 * fix is a run that gave up over a file it could not reach.
 */
async function stageInputs(run: CodingRun, named: unknown): Promise<void> {
  const dir = runInputsDir(run.id);
  run.inputs = { dir, shared: sharedInputsDir(), files: [], refused: [] };
  try {
    ensureInputsDirs(run.id);
  } catch {
    // ensureInputsDirs already warns; a run with no inputs folder simply has
    // nothing in it.
  }
  const paths = readInputPaths(named);
  if (paths.length === 0) return;
  try {
    const result = await stageRunInputs(run.id, paths);
    run.inputs = {
      dir: result.dir,
      shared: sharedInputsDir(),
      files: result.staged,
      // The NAME only: the record is drawn on a page and answered by a route,
      // and the absolute path of a file the box refused to copy says more about
      // the box's layout than the owner needs to read.
      refused: result.refused.map((r) => ({ name: path.basename(r.path).slice(0, 100) || "?", code: r.code })),
    };
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: could not stage its inputs:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Give this run a delivery pipeline, if it is to have one.
 *
 * WHO GETS ONE. The caller who asked for it, and — when the caller said
 * nothing at all — a run in a project the owner has switched the pipeline on
 * for. Never a review pass, a review-loop turn, a deployment-fix turn, a
 * read-only planner or a team's run: each of those is a TURN INSIDE somebody
 * else's chain, and a pipeline on one of them would be a second chain driving
 * the same folder.
 *
 * THE PREFLIGHT, AND THE TWO WAYS IT LANDS. A pipeline that cannot deploy must
 * say so before the box spends a build, a review pass and three improvement
 * laps getting to the stage that needs it — the owner's own rule. What differs
 * is who asked: a caller who NAMED a pipeline is refused, because they can fix
 * the request and a silent downgrade would have them believe the box was
 * shipping; a project DEFAULT stands aside instead, with the reason in the
 * run's own feed, because refusing there would take ordinary runs away from a
 * project the box cannot verify a page for just now.
 */
async function attachPipeline(run: CodingRun, input: StartRunInput, settings: RunSettings): Promise<void> {
  if (run.reviewOf || run.reviewLoopOf || run.readOnly || run.team) return;
  const asked = readPipelineInput(input.pipeline);
  // Refused at the door, with the code beside the sentence, for the reason
  // `requireDeliverable` refuses: a caller whose request was quietly dropped
  // would believe the box was shipping.
  if (asked && !asked.ok) throw new PipelineChoiceError(asked.code, asked.error);

  const explicit = asked !== null;
  let wanted: PipelineInput | null = asked?.pipeline ?? null;
  if (input.pipeline === undefined || input.pipeline === null) {
    const fromProject = await projectScopeFor(run);
    wanted = (await readPipelineDefault(fromProject)) ? defaultPipelineInput() : null;
  }
  if (!wanted) return;

  const scope = await projectScopeFor(run);
  const ready = await pipelinePreflight(scope, wanted.verify);
  if (!ready.ok) {
    if (explicit) throw new CodingAgentError("invalid", ready.reason);
    pushProgress(run, RUNNER_STEP.pipelineStopped(ready.reason));
    return;
  }

  run.pipeline = newPipeline({
    verify: wanted.verify,
    production: wanted.production,
    // The owner's review-rounds setting, frozen here — the cap on how many
    // times the work goes back round. Read with the run's other settings so a
    // pipeline and the pull-request loop it runs beside cannot disagree.
    maxRounds: await getReviewRounds(),
  });
  enterStage(run.pipeline, "build");
  addEvidence(run.pipeline, "build", { kind: "run", ref: run.id, detail: "The run that does the work." });
  // The review stage IS the automatic review pass, so the switch this run was
  // frozen with has to be ON — otherwise the pipeline would wait for a pass
  // that the settle path was never going to start.
  settings.reviewPass = true;
  run.reviewPass = true;
}

/**
 * The caller's deliverable, validated, or a thrown `invalid` saying why not.
 *
 * Thrown rather than dropped: a caller that named a deliverable the box cannot
 * accept must learn that now, while it can fix the request — a run started with
 * the deliverable quietly ignored would settle as `completed` on the old rule
 * and the caller would have no way to know its bar was never applied.
 */
function requireDeliverable(input: StartRunInput): Deliverable | null {
  const read = readDeliverableInput(input.deliverable, input.source === "owner");
  if (read === null) return null;
  if (!read.ok) throw new CodingAgentError("invalid", read.error);
  return read.deliverable;
}

/**
 * The caller's lessons, validated and rendered, or a thrown `invalid` with the
 * code saying why not — refused rather than dropped for `requireDeliverable`'s
 * reason: a dispatcher whose block was quietly ignored would count the run as
 * one that had the store. Null when the caller sent none.
 *
 * `brief` is null when the block rendered to nothing (no rules, no skill);
 * the record still says the run was given an empty one, which is a different
 * fact from being given none.
 */
function requireExperience(raw: unknown): { brief: string | null; record: RunExperience } | null {
  const read = readExperienceInput(raw);
  if (read === null) return null;
  if (!read.ok) throw new ExperienceChoiceError(read.code, read.error);
  const rendered = renderExperience(read.experience);
  return { brief: rendered.text || null, record: rendered.record };
}

/** The settings a run is spawned with, and the ceiling the device enforces itself. */
interface RunSettings {
  /** Which account pays — the owner's default, unless the caller named one. */
  provider: CodingProvider;
  /** The model for that provider, or null where the provider decides. */
  model: string | null;
  effort: CodingEffort;
  maxTurns: number;
  tokenLimit: number | null;
  generateImages: boolean;
  generateAudio: boolean;
  /** The owner's review-pass switch, read with the rest and frozen on the
   *  record (CodingRun.reviewPass): the brief and the pass decide from it. */
  reviewPass: boolean;
  /** Attempts at the deliverable, frozen on the record for the same reason. */
  completionAttempts: number;
  /** The owner's permission rules, frozen on the record for the same reason. */
  allowRules: string[];
  /** The token diet, frozen on the record (CodingRun.diet) for the same reason. */
  diet: CodingDiet;
}

/**
 * The account a fresh run is going to use, worked out before its settings are
 * read — for the spawn gate, which has to judge THAT credential: the owner's
 * default, or the provider a team role resolves to on it. `startRun`'s role
 * step reaches the same answer from the settings it reads, and has the last
 * word; the effort is no part of the question.
 */
async function ownerOrRoleProvider(role: ModelRole | null): Promise<CodingProvider> {
  const owner = await getCodingProvider();
  if (!role) return owner;
  return resolveRoleRun(role, owner, defaultModelForProvider(owner), DEFAULT_EFFORT, await getRoleModels()).provider;
}

async function readRunSettings(): Promise<RunSettings> {
  const [provider, effort, maxTurns, tokenLimit, generateImages, generateAudio, reviewPass, completionAttempts, allowRules, diet] = await Promise.all([
    getCodingProvider(), getEffort(), getMaxTurns(), getTokenLimit(), getGenerateImages(), getGenerateAudio(), getReviewPass(),
    getCompletionAttempts(),
    // With the device's own context: these rules are about to be frozen on the
    // record and handed to the CLI, which is exactly where a rule that has gone
    // inert must not travel.
    getAllowRules(allowRuleContext()),
    getDiet(),
  ]);
  return {
    provider,
    model: defaultModelForProvider(provider),
    effort,
    maxTurns,
    tokenLimit,
    generateImages,
    generateAudio,
    reviewPass,
    completionAttempts,
    allowRules,
    diet,
  };
}

/**
 * The caller's `{ provider, model }` folded into the settings a run starts
 * with, or a refusal in the words both surfaces share.
 *
 * @param settings the owner's stored defaults, already read
 * @param input the start request, whose provider/model are still untrusted
 * @param inherited what a resume carries forward, when the caller named nothing
 * @throws ProviderChoiceError naming what a caller may use instead
 */
async function applyProviderChoice(
  settings: RunSettings,
  input: Pick<StartRunInput, "provider" | "model">,
  inherited: { provider: CodingProvider; model: string | null } | null,
): Promise<RunSettings> {
  const named = input.provider !== undefined && input.provider !== null && input.provider !== "";
  // The caller's choice, else the run being resumed, else the owner's default.
  const fallback = !named && inherited ? inherited.provider : settings.provider;
  const resolved = resolveRunProvider(input.provider, input.model, fallback);
  if (!resolved.ok) throw new ProviderChoiceError(resolved.error);
  // The SAME "the caller named nothing" test the provider half uses, and for
  // the same reason: a client that always serialises the field sends
  // `"model": null`, which resolveRunProvider reads as unnamed. Tested only
  // for `undefined`, that request replaced the inherited model with the
  // provider default — breaking the one invariant this function exists to
  // keep, that a resume re-enters the session on the model it was opened with.
  const namedModel = input.model !== undefined && input.model !== null && input.model !== "";
  const keepsInheritedModel =
    inherited !== null
    && !named
    && !namedModel
    && resolved.provider === inherited.provider;
  return {
    ...settings,
    provider: resolved.provider,
    model: keepsInheritedModel ? inherited.model : resolved.model,
  };
}

/** A fresh run record: every counter at zero, nothing seen yet. */
function newRunRecord(fields: {
  /** The id a QUEUED record already gave out (startQueuedRun); a fresh one otherwise. */
  id?: string;
  task: string;
  directory: string;
  projectId: string | null;
  source: CodingRunSource;
  status: "running" | "draft" | "queued";
  settings: RunSettings;
  reviewOf?: string | null;
  reviewLoopOf?: string | null;
  reviewRound?: number | null;
  team?: RunTeam | null;
  /** The role the settings were resolved for — a team's run only. */
  modelRole?: ModelRole | null;
  readOnly?: boolean;
  extraBrief?: string | null;
  cpuBudget?: number | null;
  experience?: RunExperience | null;
  experienceBrief?: string | null;
  deliverable?: Deliverable | null;
  pipeline?: PipelineState | null;
}): CodingRun {
  const now = Date.now();
  const id = fields.id ?? newRunId();
  return {
    id,
    task: fields.task,
    directory: fields.directory,
    projectId: fields.projectId,
    source: fields.source === "owner" ? "owner" : "agent",
    status: fields.status,
    startedAt: now,
    completedAt: null,
    sessionId: null,
    model: null,
    provider: fields.settings.provider,
    requestedModel: fields.settings.model,
    modelRole: fields.modelRole ?? null,
    // Chosen at each spawn from the pool (prepareRunSecrets), not here.
    anthropicAccount: null,
    accountSwitches: [],
    summary: null,
    error: null,
    numTurns: 0,
    filesTouched: [],
    commandsRun: 0,
    permissionDenials: 0,
    deniedActions: [],
    denials: [],
    worktreeHints: 0,
    allowRules: [...fields.settings.allowRules],
    // The folder is known the moment the id is; what lands in it is staged by
    // `stageInputs` a few lines into startRun, once the caller's paths have
    // been judged one by one.
    inputs: { dir: runInputsDir(id), shared: sharedInputsDir(), files: [], refused: [] },
    // Filled at spawn by prepareRunSecrets, which is the only thing that knows
    // what this run's project resolved to.
    secretNames: [],
    effort: fields.settings.effort,
    subagentsActive: 0,
    activeSubagents: [],
    subagents: [],
    subagentsTotal: 0,
    subagentsByType: {},
    modelsUsed: [],
    commit: null,
    maxTurns: fields.settings.maxTurns,
    tokensUsed: 0,
    tokenBreakdown: emptyTokenBreakdown(),
    spawnTokens: [],
    tokenLimit: fields.settings.tokenLimit,
    thinkingTokens: 0,
    lastActivityAt: now,
    retries: 0,
    resumable: false,
    // Nothing has failed yet, so there is no verdict to carry.
    failureKind: null,
    // Nothing has paused it, so there is nothing to explain yet.
    pauseReason: null,
    reviewOf: fields.reviewOf ?? null,
    reviewLoopOf: fields.reviewLoopOf ?? null,
    reviewRound: fields.reviewRound ?? null,
    pipeline: fields.pipeline ?? null,
    team: fields.team ?? null,
    readOnly: fields.readOnly === true,
    extraBrief: fields.extraBrief ?? null,
    cpuBudget: fields.cpuBudget ?? null,
    experience: fields.experience ?? null,
    experienceBrief: fields.experienceBrief ?? null,
    // No pull request until the aftermath opens one, and no loop until it has.
    pr: null,
    review: null,
    progress: [],
    progressAt: [],
    todos: [],
    exitCode: null,
    media: { images: fields.settings.generateImages, audio: fields.settings.generateAudio },
    reviewPass: fields.settings.reviewPass,
    diet: fields.settings.diet,
    // Decided at the first spawn, from the folder as it is then — see CodingRun.visual.
    visual: null,
    mediaGenerated: { images: 0, audio: 0 },
    pgid: null,
    unit: null,
    streamOffset: 0,
    leftover: false,
    commitError: null,
    // Attached by `attachRunWorktree` once the record has an id to name it
    // with, and only for a run that is allowed one.
    worktree: null,
    // What it has to leave behind, and the bar frozen with it. The first
    // attempt's entry is opened by the caller, once it knows whether the
    // auto-PR switch gave this run an implied deliverable too — which is not
    // known here, because the branch is made after the record exists.
    deliverable: fields.deliverable ?? null,
    deliverableCheck: null,
    attempts: [],
    completionAttempts: fields.settings.completionAttempts,
    // Nobody has told it anything yet.
    messages: [],
  };
}

/**
 * Put a new record at the head of the list, newest first, and make room.
 * Never drops a held run (live, paused, drafted); trims the oldest finished
 * ones. What happens to a run that leaves is the owner's history setting
 * (src/lib/coding-run-history.ts):
 *
 *  - standard — deleted with its evidence folder and its inputs, exactly as
 *    before the setting existed: unreachable artifacts would sit on the flash
 *    forever.
 *  - extended / everything — kept as an OLDER run, its record in a file of its
 *    own and its evidence where it was; the runs file stays at MAX_RUNS_KEPT.
 *    Extended then trims the older runs to its N, oldest first.
 *  - archive — moved into the archive, record, evidence, inputs, logs and a
 *    copy of the transcript together.
 *
 * Under the disk guard (below HISTORY_MIN_FREE_BYTES free) a leaving run is
 * deleted as in standard, whatever the mode, and nothing already kept is
 * touched: the history stops growing, it is not purged behind the owner's back.
 */
function insertRun(list: CodingRun[], run: CodingRun, policy: HistoryPolicy = STANDARD_HISTORY_POLICY): void {
  list.unshift(run);
  retainRuns(list, policy);
}

function retainRuns(list: CodingRun[], policy: HistoryPolicy): void {
  // A standard box never asks the disk anything — its trim is the one it
  // always had.
  const low = policy.mode !== "standard" && isDiskLow(diskSpace());
  while (list.length > MAX_RUNS_KEPT) {
    const idx = findLastFinished(list);
    if (idx < 0) break;
    const [leaving] = list.splice(idx, 1);
    if (!low && keepsOlderRuns(policy) && writeOlderRun(leaving as unknown as HistoryRecord)) continue;
    dropRun(leaving, policy, "trimmed", low);
  }
  if (low || !hasOlderRuns()) return;
  // The older runs past what this mode keeps: extended's N, or all of them
  // under standard and archive (runs kept under a mode the owner has left —
  // the settings card said the next run would take them).
  const cap = olderRunsCap(policy, list.length);
  if (!Number.isFinite(cap)) return;
  const older = olderRunIndex();
  for (const entry of older.slice(cap)) dropOlderRun(entry, policy, "trimmed", false);
}

/**
 * A run leaving the list for good: archived under the archive mode (unless the
 * disk is low, or the archive could not take it), deleted otherwise — its
 * evidence folder, its inputs and any stream log the box still holds for it.
 */
function dropRun(run: CodingRun, policy: HistoryPolicy, reason: ArchiveReason, low: boolean): void {
  if (policy.mode === "archive" && !low) {
    const archived = archiveRun(run as unknown as HistoryRecord, {
      evidenceDir: artifactsDir(run.id),
      inputsDir: runInputsDir(run.id),
      streamLog: streamLogPath(run.id),
      stderrLog: stderrLogPath(run.id),
      transcript: transcriptPath(run),
    }, reason);
    if (archived) {
      console.error(`[coding-agent] ${run.id} moved to the archive`);
      return;
    }
  }
  removeArtifacts(run.id);
  removeRunInputs(run.id);
  removeStreamLogs(run.id);
  removeRunInbox(run.id);
}

/** An older run leaving for good — the same two ways as dropRun, and its own file with it. */
function dropOlderRun(entry: OlderRunEntry, policy: HistoryPolicy, reason: ArchiveReason, low: boolean): void {
  const run = readOlderRun(entry.id);
  if (run) dropRun(run, policy, reason, low);
  else {
    // A record that no longer parses cannot be archived; what it points at
    // still goes, so nothing is left on the flash that nothing lists.
    removeArtifacts(entry.id);
    removeRunInputs(entry.id);
  }
  removeOlderRun(entry.id);
}

/**
 * Whether a held run's folder is still there to resume or start into. Only
 * ABSENCE answers no: an EACCES, an EIO or a descriptor shortage says nothing
 * about the folder, and a held run must not be deleted — record and evidence
 * — over a passing error. Such a run is kept, and the next Clear asks again.
 */
function folderPresent(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The oldest run that is history — see isHeld for what is not, and
 *  isPrPending for the run that has settled but is still being watched. */
function findLastFinished(list: CodingRun[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    // `holdsResumableSession`, not `isHeld`: a run that GAVE UP is settled, but
    // its session is intact and its card offers Resume, so trimming it to make
    // room for a new run would take that session and its evidence folder with
    // it — unasked, and past the rail's newest dozen, invisibly.
    if (!holdsResumableSession(list[i].status) && !isPrPending(list[i].pr)) return i;
  }
  return -1;
}

/**
 * Ask a live run to end: `stop` for good, `pause` to settle with its session
 * intact. A Stop after a Pause overrides it — the later gesture is the
 * decision — while a Pause after a Stop changes nothing, and neither is
 * signalled twice.
 */
function requestEnd(run: CodingRun, state: LiveRun, kind: "stop" | "pause"): void {
  if (state.endRequested === kind || (kind === "pause" && state.endRequested !== null)) return;
  state.endRequested = kind;
  // Decided HERE, at the gesture, not at the exit: the refusal that explains
  // a pause is fresh now and stale by the time the process has finished
  // shutting down. finishRun applies it if the pause is what actually lands.
  if (kind === "pause") state.pauseReason = takePauseReason(state);
  pushProgress(run, kind === "stop" ? RUNNER_STEP.stopRequested : RUNNER_STEP.pauseRequested);
  endProcess(state);
  persist();
}

/** Idempotent: stopping a finished run just returns it. */
export function stopRun(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  // A queued run has no process to stop; taking it out of the queue is the
  // OWNER's (cancelQueuedRun, behind the owner gate of the stop route).
  if (run.status === "queued") {
    throw new CodingAgentError("invalid", "That run is queued and has not started. Only the owner can cancel a queued run, from the Coding Agent app.");
  }
  if (run.status === "paused") {
    // No process to signal — the pause already ended it. Stopping a paused
    // run is the owner closing the book on it.
    run.status = "stopped";
    run.error = "Stopped.";
    run.completedAt = run.completedAt ?? Date.now();
    // The book is closed on the pause, so its reason describes nothing now.
    run.pauseReason = null;
    // A pause left the group alone (a paused run may be resumed into the same
    // folder, and anything it started is still wanted); closing the book on it
    // is where that stops being true.
    cleanupRunResources(run, null);
    // The pause kept its one-run copies for the resume that is not coming now.
    endRunSecrets(run);
    // The pull request the pause kept "opening" (see maybeOpenPullRequest)
    // ends here with the run: this path never reaches finishRun, so nothing
    // else would settle it.
    if (isPrPending(run.pr)) {
      settlePr(run, "failed", `Stopped before a pull request was opened. The work stays on ${run.pr?.branch ?? runBranchName(run.id)}.`);
    }
    // A paused REVIEW ROUND stopped here never reaches finishRun either, so
    // the loop that is waiting for it would sit in "working" until the next
    // restart — pending in every sweep, and polled again at boot.
    endReviewLoopFor(run, "The review round was stopped while it was paused, so the pull request is still open.");
    // And the delivery pipeline, for the same reason: this path never reaches
    // finishRun, so nothing else would end it and it would hold the finish
    // notice for good.
    stopPipelineFor(run, "The run was stopped while it was paused, so the pipeline stopped here.");
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  if (run.status !== "running") return cloneRun(run);
  const state = live.get(id);
  if (!state) {
    // On disk as running but not ours — a record from a previous process that
    // loadRuns() did not get to repair. Settle it here.
    run.status = "stopped";
    run.error = "Stopped.";
    run.completedAt = Date.now();
    cleanupRunResources(run, null);
    endRunSecrets(run);
    stopPipelineFor(run, "The run was stopped, so the pipeline stopped here.");
    persist(true);
    wakeWaiters(id);
    // It held a slot on paper: the queue's next run may have it now.
    void pumpRunQueue();
    return cloneRun(run);
  }
  requestEnd(run, state, "stop");
  return cloneRun(run);
}

/**
 * Tell a run that is still going something.
 *
 * The message is QUEUED on the record first and delivered second, always in
 * that order: a run in its own systemd scope outlives this web server, and an
 * answer of "sent" that lived only in a pipe would be a promise the box could
 * not keep across a restart. What "delivered" then means depends on what the
 * harness took at spawn:
 *
 *  - a STREAMING harness gets it as its next user turn, within the second;
 *  - anything else — a plain spawn, a run reattached after a restart, a paused
 *    or drafted one — gets it at its next boundary: the spawn of another
 *    attempt at the deliverable, or the owner's own Resume.
 *
 * Either way the caller is told which, so no surface has to guess whether the
 * run has actually heard it.
 *
 * The bar is `holdsResumableSession` and not merely "is it running": a paused
 * run and a drafted one both go back in and take their queue with them, and so
 * does one that GAVE UP — its session is intact, Resume is the button its own
 * page offers, and "tell it what it missed, then resume" is the whole reason
 * that button exists. Anything genuinely over is refused, because a queue
 * nothing will ever read is worse than a plain "no".
 */
export function queueRunMessage(id: string, text: unknown): { run: CodingRun; delivered: boolean; delivery: RunMessageDelivery; messageId: string } {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (!holdsResumableSession(run.status)) {
    throw new RunMessageError(
      "settled",
      "That run is over, so there is nothing left to tell it. Start a new run instead.",
    );
  }
  // Both of these throw a RunMessageError with a stable code — the text's own
  // rules, then the queue's bound — which the route answers verbatim.
  const message = normalizeRunMessage(text);
  run.messages = appendRunMessage(run.messages, message, Date.now());
  const messageId = run.messages[run.messages.length - 1].id;
  // Written before anything is attempted: a delivery that fails must still
  // leave the message on the record, waiting.
  persist(true);
  const state = run.status === "running" ? live.get(id) : undefined;
  const delivery: RunMessageDelivery = state ? deliverRunMessages(run, state) : "next_start";
  return { run: cloneRun(run), delivered: delivery === "delivered", delivery, messageId };
}

/**
 * Wait a moment for a message sent to a run's inbox to be taken by its hook —
 * the route's way of answering "delivered" for a run between two quick tool
 * calls, rather than "after the tool call" when it is already over. Answers
 * the message's record once it is delivered, or null at the deadline (still
 * in the inbox: the hook hands it over after the call under way).
 */
export async function awaitRunMessageDelivery(runId: string, messageId: string, timeoutMs: number): Promise<RunMessage | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const run = loadRuns().find((r) => r.id === runId);
    const state = live.get(runId);
    if (run && state && state.inboxPosted.size > 0) collectInboxReceipts(run, state);
    const message = run?.messages.find((m) => m.id === messageId);
    if (!message) return null;
    if (message.deliveredAt !== null) return { ...message };
    if (Date.now() >= deadline || run?.status !== "running") return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A team message this run SENT, on its own feed (coding-team.ts calls it once
 * the message is on its way): the receiver's side is already on the record as
 * a queued message, and the sender's page must show what it said too, or a
 * reader of one run sees an answer to a question nobody asked.
 *
 * Through pushProgress like every other step — scrubbed of the run's secrets
 * and capped — and silent for a run that is gone: the message was sent either
 * way, and the board holds the audit copy.
 */
export function noteTeamMessageSent(runId: string, line: string): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run) return;
  pushProgress(run, line);
  persist();
}

/**
 * Ask a running run to PAUSE: the process ends gracefully, the record settles
 * as "paused" with its session intact, and resumeRun() respawns into it.
 * Idempotent the way stopRun is: pausing anything not running returns it.
 */
export function pauseRun(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status !== "running") return cloneRun(run);
  const state = live.get(id);
  if (!state) {
    // On disk as running but not ours — settle it as paused only if it has a
    // session to come back to; otherwise it is simply lost.
    run.status = run.sessionId ? "paused" : "failed";
    run.resumable = run.sessionId !== null;
    // No live process, so no refusal was ever recorded against it: this is
    // the ordinary pause, and it says so rather than leaving the field null
    // for a reader to guess at.
    run.pauseReason = run.sessionId ? { kind: "owner" } : null;
    if (!run.sessionId) run.error = "The run was lost before it could be paused.";
    run.completedAt = Date.now();
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  requestEnd(run, state, "pause");
  return cloneRun(run);
}

/**
 * Starts and resumes under way, by run id.
 *
 * Both read the record's status synchronously and then AWAIT their gates —
 * the switch, readiness, setpriv, the folder — before flipping it to
 * "running" and spawning. Two POSTs for the same run arriving together both
 * saw "draft" (or "paused"), both passed, and both spawned: two processes
 * on one record. The first caller's transition is THE transition; a second
 * ask for the same run while it is under way gets the same promise, exactly
 * as a start of a run already running gets the running record back.
 */
const transitions = store.transitions;

function singleFlight(id: string, transition: () => Promise<CodingRun>): Promise<CodingRun> {
  const inFlight = transitions.get(id);
  if (inFlight) return inFlight;
  const pending = transition().finally(() => transitions.delete(id));
  transitions.set(id, pending);
  return pending;
}

/**
 * Resume a PAUSED run in place: the same record, the same session, picked up
 * where the transcript left off. Runs through the same gates a start does —
 * the owner's switch, readiness, the capability drop, one run at a time.
 */
export function resumeRun(id: string, opts: { automatic?: boolean } = {}): Promise<CodingRun> {
  return singleFlight(id, () => resumeRunOnce(id, opts.automatic === true));
}

/**
 * `automatic` is the BOX resuming a run that was waiting for an Anthropic
 * limit to reset (TASK-902) — not the owner pressing Resume. So it is not an
 * attempt of theirs (the attempt count stays what it was), the permission rules
 * the run was started with stay frozen, and the run is told the limit reset
 * rather than that somebody resumed it.
 */
async function resumeRunOnce(id: string, automatic = false): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status === "running") return cloneRun(run);
  // A run that GAVE UP is resumable in place for the same reason a paused one
  // is: its session is intact (the harness finished normally — what it produced
  // was simply not the deliverable), its work is on disk, and carrying on in
  // that session is the one thing that helps. It is the only other status this
  // accepts, and the card's Resume button on a `gave_up` run is this call.
  if (run.status !== "paused" && run.status !== "gave_up") {
    throw new CodingAgentError("invalid", "Only a paused run, or one that gave up, can be resumed in place. Start a new run instead.");
  }
  // The owner's own Resume starts the refused-credential budget afresh
  // (MAX_AUTH_SWITCHES): refusals from an earlier stretch of the run say
  // nothing about the accounts the owner may have signed in again since.
  if (!automatic) store.anthropicAuthRetries?.delete(run.id);
  // The account the session was OPENED on — a resume cannot move to another
  // one, so if that credential is gone the resume is refused rather than
  // quietly re-enacted somewhere else. Handed to the gate rather than checked
  // beside it, so the box's own half and the credential are one verdict.
  // Held from the gate to the flip below, like every other start — see
  // `startingRuns`.
  const releaseSlot = await assertCanSpawn(run.team ?? null, run.provider, !run.team && typeof run.reviewOf === "string");
  // Held beside the slot — see `startRun`. A resume reaches the same folder a
  // removal may be about to take, and by the same synchronous claim.
  let releaseDirectory: () => void = () => {};
  try {
    const tools = await requireSpawnTools();
    // The folder must still be there. A team worker's worktree is removed when
    // its task is decided, and a run resumed into a cwd that no longer exists
    // makes Node report ENOENT against the EXECUTABLE — "spawn /usr/bin/setpriv
    // ENOENT" — blaming a binary that is present, on a record that had already
    // been flipped to running. Checked here, before that flip, the way a draft
    // start checks it.
    // A run with a copy of its own may have had it removed at settle (it left
    // nothing on its branch) or by the weekly sweep. The BRANCH survived both,
    // so the tree is made again from it and the resume carries on in the folder
    // the session was opened in — which is what `--resume` needs.
    if (run.worktree) run.worktree = await reopenWorktree(run);
    try {
      run.directory = await realDirectory(run.directory);
    } catch {
      throw new CodingAgentError("not_found", `The folder this run worked in is gone (${run.directory}), so it cannot be resumed. Start a new run instead.`);
    }
    releaseDirectory = assertDirectoryFree(run.directory, run.id, run.team ?? null, run.readOnly === true);
    // The one place a run's permission rules are RE-READ rather than kept.
    //
    // Everything else about a run is frozen on its record precisely so the tools
    // it holds cannot change under it while it works (see CodingRun.allowRules).
    // A resume is the exception because it is not something that happens to a
    // run — it is the owner pressing a button, deliberately, after the run
    // stopped. "Allow next time" exists to answer a refusal on this very page and
    // offers Resume in the same breath; carrying the old list through would hand
    // the run back the refusal the owner just answered, and the button would be a
    // lie. Narrowing works the same way: a rule removed before the resume is gone
    // from the resumed run too.
    if (!automatic) run.allowRules = await getAllowRules(allowRuleContext());
    // Read BEFORE the flip below, which is what makes this a resume: the
    // continuation text and the pull-request step both depend on which of the two
    // resumable endings this run is coming back from.
    const gaveUp = run.status === "gave_up";
    // The pause gap is not working time: shift the start forward by it, so the
    // elapsed clock and the ETA speak of effort, not of the night in between.
    if (run.completedAt !== null) run.startedAt += Math.max(0, Date.now() - run.completedAt);
    run.status = "running";
    run.completedAt = null;
    run.error = null;
    run.exitCode = null;
    // The pause is over, so its reason is history. Left in place it would sit
    // on a running record and, worse, survive into the run's next settle.
    run.pauseReason = null;
    run.lastActivityAt = Date.now();
    // The owner's own go at the deliverable, on the record like every other. It
    // is NOT counted against the cap before it is made — the cap bounds what the
    // BOX spends unasked, and a Resume the owner pressed is their decision, not
    // the box's budget. The gate judges it when it settles, exactly as it judged
    // the attempts before it.
    // A run that gave up with no pull request ever opened gets the step back, so
    // the owner's Resume can actually reach the deliverable it is resumed for.
    if (gaveUp) reopenPullRequestStep(run);
    if (!automatic) openAttempt(run);
    pushProgress(run, automatic ? RUNNER_STEP.resumedAfterLimit : RUNNER_STEP.resumedByOwner);
    // RE-RESOLVED, like the permission rules just above and for the same reason:
    // a resume is the owner's own deliberate act, so an entry they have un-ticked
    // since the pause is not handed back, and one they have ticked is.
    await prepareRunSecrets(run);
    persist(true);
    console.error(`[coding-agent] ${run.id} resumed from ${gaveUp ? "giving up" : automatic ? "waiting for an Anthropic limit to reset" : "pause"}`);
    startProjectIcon(run);
    // The session already holds the task; replaying it verbatim would read as
    // "start over". Say what actually happened instead — and for a run that gave
    // up, what it is being resumed FOR: the owner pressed Resume on a page whose
    // one red sentence is the missing deliverable, so arriving back in the session
    // with "you were paused" would be the box losing the thread of its own
    // question.
    const missing = gaveUp ? run.deliverableCheck?.missing?.trim() : null;
    const deliverable = gaveUp ? deliverableFor(run) : null;
    const continuation = !run.sessionId
      ? undefined
      : missing && deliverable
        ? `${completionNudge(deliverable, missing, null)}\n\nThe owner resumed this run themselves. Your evidence folder is ${artifactsDir(run.id)}.`
        : automatic
          ? `You were paused because every Anthropic account on this ClawBox had reached its usage limit. The limit has reset and you are resumed in the same session. Continue the task where the transcript leaves off; do not start over. Your evidence folder is ${artifactsDir(run.id)}.`
          : `You were ${gaveUp ? "stopped short and have been resumed by the owner" : "paused by the owner and are now resumed"} in the same session. Continue the task where the transcript leaves off; do not start over. Your evidence folder is ${artifactsDir(run.id)}.`;
    spawnOrSettle(run, run.sessionId, tools, { effort: run.effort, maxTurns: run.maxTurns }, continuation);
    return cloneRun(run);
  } finally {
    releaseDirectory();
    releaseSlot();
  }
}

/** Drafts the list will hold; beyond this, start or discard one first. */
export const MAX_DRAFT_RUNS = 10;

/**
 * Create a run the owner will start LATER: the full record, validated the way
 * a start is (task, folder), but no process. It sits in the list as "draft"
 * until startDraftRun spawns it or deleteDraftRun discards it.
 */
export async function createDraftRun(input: StartRunInput): Promise<CodingRun> {
  const task = normalizeTask(input.task);
  if (loadRuns().filter((r) => r.status === "draft").length >= MAX_DRAFT_RUNS) {
    throw new CodingAgentError("invalid", `There are already ${MAX_DRAFT_RUNS} drafted runs. Start or discard one first.`);
  }
  const { directory, projectId } = await resolveWorkingDirectory(input);
  // Snapshot of today's settings for the card; re-read at start, because the
  // run keeps the settings it STARTS with, not the ones it was drafted under.
  // A draft freezes its account. Unlike the effort and the ceilings — which
  // startDraftRunOnce deliberately re-reads, because they have no per-run form
  // and can only have come from the owner's default — the provider and its
  // model are something the CALLER may have named here, and re-reading would
  // throw that choice away without saying so.
  const settings = await applyProviderChoice(await readRunSettings(), input, null);
  const run = newRunRecord({
    task,
    directory,
    projectId,
    source: input.source,
    status: "draft",
    settings,
    // Validated when the draft is MADE, so a deliverable the box will not
    // accept is refused at the keystroke rather than at the start hours later.
    deliverable: requireDeliverable(input),
  });
  pushProgress(run, RUNNER_STEP.drafted);
  const history = await getHistoryPolicy();
  insertRun(loadRuns(), run, history);
  persist(true);
  console.error(`[coding-agent] ${run.id} drafted by ${run.source} for ${run.directory}`);
  return cloneRun(run);
}

/** Start a drafted run now. The same gates and the same freshness rules as startRun. */
export function startDraftRun(id: string): Promise<CodingRun> {
  return singleFlight(id, () => startDraftRunOnce(id));
}

async function startDraftRunOnce(id: string): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status === "running") return cloneRun(run);
  // A draft the owner started while the box was full waits in the queue as
  // itself, and the queue starts it here (startQueuedRun).
  const fromQueue = run.status === "queued" && run.queued?.start?.kind === "draft";
  if (run.status !== "draft" && !fromQueue) throw new CodingAgentError("invalid", "Only a drafted run can be started this way.");
  // In order: a draft started while runs wait for a slot goes behind them.
  if (!fromQueue && hasQueuedRuns()) return queueDraft(run);
  // The account this draft named, not whatever the default is now. Checked
  // before the record is flipped to "running": a draft for an account whose
  // key the owner has since removed should be refused with a sentence, not
  // spawned into a wrapper that dies.
  // Held from the gate to the flip below, like every other start — see
  // `startingRuns`. Every slot taken: queued, not refused.
  let releaseSlot: () => void;
  try {
    releaseSlot = await assertCanSpawn(run.team ?? null, run.provider, !run.team && typeof run.reviewOf === "string");
  } catch (err) {
    if (err instanceof SlotsFullError && !fromQueue) return queueDraft(run);
    throw err;
  }
  // Held beside the slot — see `startRun`. A draft that starts reaches the same
  // folder a removal may be about to take, and by the same synchronous claim.
  let releaseDirectory: () => void = () => {};
  try {
    const tools = await requireSpawnTools();
    // The folder must still be there — it was only checked when drafted.
    run.directory = await realDirectory(run.directory);
    releaseDirectory = assertDirectoryFree(run.directory, run.id, run.team ?? null, run.readOnly === true);
    // The copy of the project is made at START and not when the draft was
    // written: a draft may sit for days, and a worktree made for one that is
    // never started would be a branch and a folder nobody asked for.
    if (!run.team && !run.readOnly && !run.worktree) await attachRunWorktree(run, run.directory);
    // Settings are read at START: a run keeps what it starts with.
    //
    // The provider and its model are deliberately NOT among them. They are the
    // one setting here a caller can name PER RUN, so re-reading would silently
    // overwrite a choice the draft was created with; the others have no per-run
    // form and can only have come from the owner's stored default anyway.
    const settings = await readRunSettings();
    const writersLive = loadRuns().filter((r) => isLive(r.status) && !r.readOnly && r.id !== run.id).length;
    run.cpuBudget = runCpuBudget({ cpus: hostCpuCount(), concurrent: writersLive + 1, onBattery: await onBatteryPower() });
    run.effort = settings.effort;
    run.maxTurns = settings.maxTurns;
    run.tokenLimit = settings.tokenLimit;
    run.media = { images: settings.generateImages, audio: settings.generateAudio };
    run.completionAttempts = settings.completionAttempts;
    run.diet = settings.diet;
    run.status = "running";
    run.queued = null;
    run.startedAt = Date.now();
    run.lastActivityAt = Date.now();
    // The bar the draft was created with, now that it is actually starting.
    openAttempt(run);
    pushProgress(run, fromQueue ? RUNNER_STEP.startedFromQueue : RUNNER_STEP.startedFromDraft);
    // Resolved now and not when the draft was written: a draft can sit for days,
    // and the secrets a run gets are the ones ticked at the moment it starts.
    await prepareRunSecrets(run);
    persist(true);
    console.error(`[coding-agent] ${run.id} started from draft by ${run.source} in ${run.directory}`);
    startProjectIcon(run);
    spawnOrSettle(run, null, tools, settings);
    return cloneRun(run);
  } finally {
    releaseDirectory();
    releaseSlot();
  }
}

// ─── The run queue ───────────────────────────────────────────────────────────

/**
 * Runs that may wait for a slot at once. A queue is a promise to start each
 * of them, unattended, in order; beyond this, the caller is told to wait.
 */
export const MAX_QUEUED_RUNS = 10;
/** How soon the queue looks again after it stopped for something that clears by itself — the switch off, the harness not ready. */
export const QUEUE_RETRY_MS = 60_000;
/** Refusals that are the BOX's state, not the run's: the queue waits them out rather than failing the run. */
const QUEUE_WAITS: ReadonlySet<CodingAgentErrorKind> = new Set(["disabled", "not_ready", "limited", "busy"]);

function hasQueuedRuns(): boolean {
  return loadRuns().some((r) => r.status === "queued");
}

/** The queued runs in the order they start in: the order they were asked for. */
function queuedRuns(): CodingRun[] {
  return loadRuns().filter((r) => r.status === "queued").sort((a, b) => (a.queued?.at ?? 0) - (b.queued?.at ?? 0));
}

/** A queued run's place in line, 1 being next; null for anything not queued. */
export function queuePosition(id: string): number | null {
  const at = queuedRuns().findIndex((r) => r.id === id);
  return at < 0 ? null : at + 1;
}

/**
 * Start a run, or QUEUE it when the box is already running every run the
 * owner allows: the run route's start (owner and MCP bearer alike), so a
 * second ask is never refused with CONFLICT for want of a slot. In order — a
 * start while runs are waiting goes behind them, even when a slot just freed.
 * Every other refusal (the switch, readiness, a bad folder) is still a refusal.
 */
export async function startOrQueueRun(input: StartRunInput): Promise<{ run: CodingRun; queued: boolean }> {
  if (!hasQueuedRuns()) {
    try {
      return { run: await startRun(input), queued: false };
    } catch (err) {
      if (!(err instanceof SlotsFullError)) throw err;
    }
  }
  const run = await queueRun(input);
  // Room may have come free between the refusal and the queue.
  void pumpRunQueue();
  return { run, queued: true };
}

/**
 * The QUEUED record: validated the way a start is — the task, the folder (or
 * the run it continues), the account, the deliverable, the experience block —
 * so a request the box would refuse is refused NOW, to the caller who can fix
 * it, not when its turn comes hours later. Persisted with the request it is
 * started with; nothing is staged, branched or spawned until then.
 */
async function queueRun(input: StartRunInput): Promise<CodingRun> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. The owner can turn it on in the Coding Agent app on the ClawBox desktop.");
  }
  const task = normalizeTask(input.task, isBoxWrittenTask(input));
  requireExperience(input.experience);
  if (queuedRuns().length >= MAX_QUEUED_RUNS) {
    throw new CodingAgentError("busy", `There are already ${MAX_QUEUED_RUNS} coding runs waiting for a slot on this ClawBox. Wait for the queue to move, or ask the owner to cancel one.`);
  }
  const resumeRunId = typeof input.resumeRunId === "string" ? input.resumeRunId.trim() : "";
  let directory: string;
  let projectId: string | null;
  let inherited: { provider: CodingProvider; model: string | null } | null = null;
  let fixing: CodingRun | null = null;
  if (resumeRunId) {
    const previous = loadRuns().find((r) => r.id === resumeRunId) ?? null;
    if (!previous) throw new CodingAgentError("not_found", "There is no coding run with that id to resume.");
    if (!previous.sessionId && input.freshSession !== true) {
      throw new CodingAgentError("invalid", "That run never started a Claude Code session, so it cannot be resumed. Start a new run instead.");
    }
    if (input.fixCi === true) {
      ciFixAttempt(previous, null);
      fixing = previous;
    }
    directory = previous.directory;
    projectId = previous.projectId;
    inherited = { provider: previous.provider, model: previous.requestedModel };
  } else {
    if (input.fixCi === true) throw new CodingAgentError("invalid", "A Fix CI run continues the run whose pull request failed: name it in resumeRunId.");
    ({ directory, projectId } = await resolveWorkingDirectory(input));
  }
  const settings = await applyProviderChoice(await readRunSettings(), input, inherited);
  const run = newRunRecord({ task, directory, projectId, source: input.source, status: "queued", settings, deliverable: requireDeliverable(input) });
  // Claimed now, so the failure is not offered a second Fix CI while this one waits.
  if (fixing?.ci) fixing.ci = { ...fixing.ci, fixRunId: run.id };
  run.queued = {
    at: Date.now(),
    start: {
      kind: "new",
      task: input.task,
      projectId: typeof input.projectId === "string" ? input.projectId : null,
      directory: typeof input.directory === "string" ? input.directory : null,
      resumeRunId: resumeRunId || null,
      provider: input.provider,
      model: input.model,
      deliverable: input.deliverable,
      pipeline: input.pipeline,
      inputs: input.inputs,
      experience: input.experience,
      ...(input.fixCi === true ? { fixCi: true } : {}),
    },
  };
  pushProgress(run, RUNNER_STEP.queued(queuedRuns().length + 1));
  insertRun(loadRuns(), run, await getHistoryPolicy());
  persist(true);
  console.error(`[coding-agent] ${run.id} queued by ${run.source} for ${run.directory}`);
  return cloneRun(run);
}

/**
 * A queued Fix CI continuation that leaves the queue without ever starting —
 * the owner canceled it, or its turn came and it could not start — gives back
 * the failure it claimed when it was queued (`queueRun`), so a Fix CI can be
 * offered for it again. One that started keeps it: it did its attempt.
 */
function releaseCiClaim(run: CodingRun): void {
  const start = run.queued?.start;
  if (start?.kind !== "new" || start.fixCi !== true || !start.resumeRunId) return;
  const previous = loadRuns().find((r) => r.id === start.resumeRunId);
  if (previous?.ci?.fixRunId === run.id) previous.ci = { ...previous.ci, fixRunId: null };
}

/** A draft the owner started while every slot was taken: the same record, waiting its turn. */
function queueDraft(run: CodingRun): CodingRun {
  const position = queuedRuns().length + 1;
  run.status = "queued";
  run.queued = { at: Date.now(), start: { kind: "draft" } };
  pushProgress(run, RUNNER_STEP.queued(position));
  persist(true);
  void pumpRunQueue();
  return cloneRun(run);
}

/** The queue's start of one run: the request it was queued with, under the id it was given. */
function startQueuedRun(id: string): Promise<CodingRun> {
  return singleFlight(id, async () => {
    const run = loadRuns().find((r) => r.id === id);
    if (!run || run.status !== "queued") throw new CodingAgentError("invalid", "That queued run is no longer waiting: it was canceled or has already started.");
    const start = run.queued?.start;
    // Straight to the draft's own start, not through startDraftRun: this IS
    // the transition for the id, and asking for it again would wait on itself.
    if (!start || start.kind === "draft") return startDraftRunOnce(id);
    return startRun({
      task: start.task ?? run.task,
      projectId: start.projectId ?? null,
      directory: start.directory ?? null,
      resumeRunId: start.resumeRunId ?? null,
      provider: start.provider,
      model: start.model,
      deliverable: start.deliverable,
      pipeline: start.pipeline,
      inputs: start.inputs,
      experience: start.experience,
      fixCi: start.fixCi === true,
      source: run.source,
      queuedRunId: id,
    });
  });
}

/**
 * Start what the queue holds, in order, while there are slots. Called when a
 * run settles (finishRun), when one stopped without ever settling, when the
 * owner raises the limit, after a run is queued, and at boot — the queue is
 * on disk, so it survives a restart and is picked up where it was.
 *
 * One pass at a time; a slot that frees during a pass makes it look again.
 * A run whose start the BOX refuses for now (the switch, readiness, a limit)
 * keeps its place and the queue looks again in QUEUE_RETRY_MS; one refused for
 * itself (its folder is gone, its request no longer valid) is settled failed
 * with the reason, and the next one goes.
 */
export function pumpRunQueue(): Promise<string[]> {
  if (store.queuePump) {
    store.queuePumpAgain = true;
    return store.queuePump;
  }
  const pass = (async () => {
    const started: string[] = [];
    do {
      store.queuePumpAgain = false;
      for (;;) {
        const next = queuedRuns()[0];
        if (!next) break;
        try {
          await startQueuedRun(next.id);
          started.push(next.id);
        } catch (err) {
          // Every slot is taken: its turn comes when a run settles.
          if (err instanceof SlotsFullError) break;
          if (err instanceof CodingAgentError && QUEUE_WAITS.has(err.kind)) {
            armQueueRetry();
            break;
          }
          failQueuedRun(next.id, err);
        }
      }
    } while (store.queuePumpAgain);
    return started;
  })().finally(() => {
    store.queuePump = undefined;
  });
  store.queuePump = pass;
  return pass;
}

function armQueueRetry(): void {
  if (store.queueRetry) return;
  store.queueRetry = setTimeout(() => {
    store.queueRetry = null;
    void pumpRunQueue();
  }, QUEUE_RETRY_MS);
  store.queueRetry.unref?.();
}

/** A queued run its turn could not start, for a reason of its own: settled failed, saying why, on its own page. */
function failQueuedRun(id: string, err: unknown): void {
  const run = loadRuns().find((r) => r.id === id);
  if (!run || run.status !== "queued") return;
  releaseCiClaim(run);
  run.status = "failed";
  run.queued = null;
  run.error = `Its turn in the queue came, and it could not start: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
  run.completedAt = Date.now();
  pushProgress(run, RUNNER_STEP.finished("failed"));
  persist(true);
  wakeWaiters(id);
}

/**
 * Take a run out of the queue before it starts — the OWNER's gesture alone
 * (the stop route lets only the owner's session reach this; the MCP bearer may
 * queue and read, never cancel). A start already under way for it is waited
 * for first: then it is running, and Stop is the way to end it.
 */
export async function cancelQueuedRun(id: string): Promise<CodingRun> {
  const inFlight = transitions.get(id);
  if (inFlight) await inFlight.catch(() => undefined);
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status !== "queued") {
    if (run.status === "running") throw new CodingAgentError("invalid", "That run has already left the queue and started. Stop it instead.");
    return cloneRun(run);
  }
  releaseCiClaim(run);
  run.status = "stopped";
  run.queued = null;
  run.error = "Canceled by the owner before it started.";
  run.completedAt = Date.now();
  pushProgress(run, RUNNER_STEP.queueCanceled);
  persist(true);
  wakeWaiters(id);
  console.error(`[coding-agent] ${run.id} canceled in the queue by the owner`);
  return cloneRun(run);
}

/** Discard a draft. Only drafts: everything else is history and history stays. */
export function deleteDraftRun(id: string): void {
  const list = loadRuns();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (list[idx].status !== "draft") {
    throw new CodingAgentError("invalid", "Only a draft can be deleted; finished runs are history.");
  }
  removeArtifacts(id);
  removeRunInputs(id);
  list.splice(idx, 1);
  persist(true);
}

/**
 * Starts that have passed the gate and are not yet visible to `loadRuns()`.
 *
 * The gate counts LIVE runs, and a new one becomes live several awaits later —
 * the spawn tools, the working folder, the settings, the worktree, the auto-PR
 * read all sit in between. Two starts that arrive together therefore both saw
 * room for one, and on a board sized for two `claude -p` processes the third is
 * exactly what the setting exists to prevent. `teamSpawnSlot` already answers
 * this shape with its `starting` count; this is the same answer for the runs
 * that are nobody's team.
 *
 * Held from the gate to the insert, released in a `finally` so a start that
 * throws in between gives its slot back. A team's start is counted under its
 * team too (`startingTeams`), so the team's own look does not count it twice.
 */
function holdSpawnSlot(review = false, teamId: string | null = null): () => void {
  const key = review ? "startingReviews" : "startingRuns";
  store[key] += 1;
  const teams = teamId ? (store.startingTeams ??= new Map()) : null;
  if (teams && teamId) teams.set(teamId, (teams.get(teamId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Never below zero: a double release would otherwise make the counter a
    // permanent discount on the limit.
    store[key] = Math.max(0, store[key] - 1);
    if (teams && teamId) {
      const left = (teams.get(teamId) ?? 0) - 1;
      if (left > 0) teams.set(teamId, left);
      else teams.delete(teamId);
    }
  };
}

/**
 * The gates every spawn passes: the owner's switch, readiness, the slot.
 *
 * Answers the slot's RELEASE. The reservation is taken here, synchronously
 * with the count it was judged against — a caller that took it after this
 * resolved would still have raced another caller inside this function, whose
 * own awaits (the switch, readiness, the limit) are where the two starts read
 * the same number.
 */
async function assertCanSpawn(team: RunTeam | null = null, provider?: CodingProvider, reviewPass = false): Promise<() => void> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. The owner can turn it on in the Coding Agent app on the ClawBox desktop.");
  }
  const readiness = await checkReadiness();
  // The provider THIS run will use, when the caller knows it — not the owner's
  // default. `readiness.ready` is the default provider's verdict, and
  // `setCodingProvider` deliberately accepts an account before its key is
  // pasted, so a box can sit with an unconnected default while the other
  // provider works perfectly. Judged on `ready` alone, a run that explicitly
  // named the working account was refused, and the sentence it was refused
  // with named the account it had never asked for.
  //
  // No provider named — the team paths and the tests that predate this — falls
  // back to `ready`, which is the old behaviour exactly.
  const verdict = provider
    ? readiness.providers.find((p) => p.id === provider)
    : null;
  let refusal: string | null = null;
  if (verdict) {
    // The shared half still applies: those problems are in every provider's
    // way. `CodingProviderReadiness.ready` already folds them in.
    if (!verdict.ready) {
      refusal = [...sharedProblems(readiness), ...verdict.problems].join(" ");
    }
  } else if (!readiness.ready) {
    refusal = readiness.problems.join(" ");
  }
  // Every Anthropic account at its usage limit (TASK-902): refused before
  // anything spawns, with the time the first one is back — a queue that reads
  // this waits for that time instead of spending an attempt on a run
  // Anthropic would only refuse. Only for a run that is actually going to
  // Anthropic, and never over a pool this box cannot read (the spawn's own
  // choice copes with that).
  if (!refusal && provider === "anthropic") {
    const waitUntil = await anthropicPoolWait();
    if (waitUntil !== undefined) {
      throw new CodingAgentError(
        "limited",
        `Every Anthropic account on this ClawBox is at its usage limit${waitUntil !== null ? `; the first one is back at ${formatResetClock(waitUntil)} (${new Date(waitUntil).toISOString()})` : ""}.`
        + " Wait for the limit reset rather than retrying, or connect another account in Settings → Providers.",
      );
    }
  }
  // OpenAI turned the last run away at its usage limit (finishRun remembered
  // when it is over): the same wait as an Anthropic pool at its limit, so a
  // queue holds the run until then instead of spending it on a refusal.
  if (!refusal && provider === "openai") {
    const until = await openAILimitedUntil();
    if (until !== null) {
      throw new CodingAgentError(
        "limited",
        `OpenAI is at its usage limit for this ClawBox; it should be back at ${formatResetClock(until)} (${new Date(until).toISOString()}).`
        + " Wait for the limit reset rather than retrying, or connect OpenAI again with another key or account in the Coding Agent settings.",
      );
    }
  }
  if (refusal) {
    throw new CodingAgentError("not_ready", refusal);
  }
  if (team) {
    // A team's run shares the box with every other run: the owner's limit,
    // the team's own MAX_TEAM_WORKERS and the memory guard, each refusal a
    // wait the orchestrator sits out. Judged and held in one step — see
    // judgeTeamSlot.
    const slot = await judgeTeamSlot(team, 0, true);
    if (!slot.ok) throw new CodingAgentError("busy", slot.reason, slot.wait);
    return slot.release;
  }
  const limit = await getMaxParallelRuns();
  // BOTH terms read after the last await, in the same synchronous window the
  // slot is taken in. Read before it, the list is a snapshot from before a
  // start that has since inserted its record and given its slot back — so the
  // run is missing from `active` AND from `startingRuns`, and the gate counts
  // it nowhere.
  const freeMb = reviewPass && TEAM_SPAWN_MIN_AVAILABLE_MB > 0 ? await memAvailableMb() : null;
  const live = loadRuns().filter((r) => isLive(r.status));
  if (reviewPass) {
    // The automatic review pass has its own small pool, so it never takes a
    // start slot from the owner's runs; the memory guard still applies.
    const reviewing = live.filter((r) => r.reviewOf).length + store.startingReviews;
    if (reviewing >= REVIEW_PASS_POOL_RUNS) {
      throw new SlotsFullError(`This ClawBox is already running ${reviewing} review passes at once, which is all it allows.`);
    }
    if (reviewing + live.length + store.startingRuns >= 1 && freeMb !== null && freeMb < TEAM_SPAWN_MIN_AVAILABLE_MB) {
      throw new CodingAgentError("busy", `Not enough free memory for a review pass (${freeMb} MB free, ${TEAM_SPAWN_MIN_AVAILABLE_MB} MB needed).`, true);
    }
    return holdSpawnSlot(true);
  }
  const active = parallelSlotHolders(live);
  // The runs already going PLUS the starts that have passed this gate and have
  // not reached their record yet — see `startingRuns`.
  const going = active.length + store.startingRuns;
  if (going >= limit) {
    throw new SlotsFullError(
      limit === 1 && active.length > 0
        ? `A coding run is already in progress (${active[0].id}). Wait for it or stop it first.`
        : `This ClawBox is already starting or running ${going} coding runs at once, which is all it allows. Wait for one to finish, stop one, or raise the limit in the Coding Agent settings.`,
    );
  }
  return holdSpawnSlot();
}

/**
 * `undefined` when an Anthropic account can answer (or the pool cannot be read
 * — never a refusal over a read that failed); otherwise when the first limited
 * account is back, or null when none will be back by itself (every account
 * needs the owner).
 */
async function anthropicPoolWait(): Promise<number | null | undefined> {
  try {
    const health = poolHealth(await readAccounts(), Date.now());
    return health.allLimited && health.limited > 0 ? health.nextResetAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The live run that keeps a run from starting in `directory`, or null.
 *
 * A run of a TEAM is not kept out by its own team: the team's runs share the
 * project on purpose — its reviewers read the project while its workers write
 * in worktrees beneath it, and several tasks can be in review at once — and
 * the orchestrator already decides which of them may write where. Counting
 * them as strangers refused the reviewer of every task that finished while a
 * sibling's reviewer was still reading, and each refusal was a review skipped
 * (bench, 2026-09-22). A run of no team, or of another team, is refused as
 * before — and so are two WRITERS of one team in one folder (the owner
 * resuming a worker that gave up while its sibling writes in the same
 * in-place checkout): the exemption needs one of the two to be read-only.
 */
export function folderHolder<R extends Pick<CodingRun, "id" | "status" | "directory" | "team" | "readOnly">>(
  runs: readonly R[],
  directory: string,
  team: RunTeam | null = null,
  exceptRunId?: string,
  readOnly = false,
): R | null {
  return runs.find((r) =>
    isLive(r.status)
    && r.id !== exceptRunId
    && r.directory === directory
    && !(team && r.team?.id === team.id && (readOnly || r.readOnly === true)),
  ) ?? null;
}

/**
 * Refuse a second run in the SAME working folder.
 *
 * The concurrency limit above is about the box's memory; this is the rule it
 * used to imply. A run that got a worktree has a folder nobody else is in, so
 * this never fires for it — it fires for the folders that keep the old
 * in-place behaviour (a plain folder with no git history, a code project
 * inside ClawBox's own checkout), where two runs really would edit each
 * other's half-written files and each settle would commit the other's. A
 * team's own runs do not count against each other — see `folderHolder`.
 */
function assertDirectoryFree(directory: string, exceptRunId?: string, team: RunTeam | null = null, readOnly = false): () => void {
  // A project the owner is REMOVING right now, before the run store is asked.
  //
  // This is the run half of a mutual exclusion, and the removal holds the other
  // (`beginProjectRemoval` in src/lib/coding-project-removal-lock.ts). The gap
  // it closes: a removal checks for live runs, then spends four git processes
  // before the folder actually goes. A run that started inside that window
  // found nothing live and began writing into a folder on its way out.
  if (isProjectBeingRemoved(directory)) {
    throw new CodingAgentError(
      "busy",
      "That project folder is being removed right now. Wait for it to finish, or work somewhere else.",
    );
  }
  const busy = folderHolder(loadRuns(), directory, team, exceptRunId, readOnly);
  if (busy) {
    throw new CodingAgentError(
      "busy",
      `Another coding run (${busy.id}) is already working in that folder. Wait for it or stop it first.`,
    );
  }
  // CLAIMED HERE, with no await between the read above and this write, and held
  // by the caller until the record is visible to `loadRuns()`.
  //
  // The other half of the same exclusion. This check passes synchronously and
  // then the caller spends six awaits before `insertRun` — so a removal that
  // looked at the run store during that window saw nothing live and moved the
  // folder out from under a run already committed to starting in it. Re-reading
  // the store later cannot find it either; only a claim can. See the module
  // header of coding-project-removal-lock.ts for why write-then-read on both
  // sides is what makes this sound.
  return beginRunStart(directory);
}

/**
 * setpriv, resolved fresh rather than carried out of checkReadiness: this
 * path is what strips the web server's network capabilities off the run, and
 * a run must never start without it — not even if the binary vanished a
 * moment ago.
 */
async function requireSpawnTools(): Promise<SpawnTools> {
  const [setprivPath, scope] = await Promise.all([requireSetpriv(), probeSystemdRun()]);
  // A box that cannot detach a run still runs: the run is a plain child again
  // and readiness says so (`detachedRuns`). Refusing to start over it would turn
  // a run that dies at the next restart into a run that never happens.
  return { setprivPath, scopePath: scope.available ? scope.path : null };
}

async function requireSetpriv(): Promise<string> {
  const setprivPath = await findExecutableOnPath(CAPABILITY_DROP_COMMAND);
  if (!setprivPath) {
    throw new CodingAgentError(
      "not_ready",
      `${CAPABILITY_DROP_COMMAND} (part of util-linux) is missing, and without it a run would inherit the web server's network capabilities. Install util-linux.`,
    );
  }
  return setprivPath;
}

/**
 * spawnRun, with a synchronous throw settling the record.
 *
 * The record is already on disk as "running". If spawn throws SYNCHRONOUSLY
 * — a cwd that vanished between the check and here, a setpriv that is not
 * executable — nothing would ever settle it: `live` has no entry, so the
 * boot sweep is the only thing that would, and until the next restart the
 * one-run-at-a-time rule answers every later run with "busy". Settle it
 * here, then report the failure to the caller.
 */
function spawnOrSettle(
  run: CodingRun,
  resumeSessionId: string | null,
  tools: SpawnTools,
  settings: { effort: CodingEffort; maxTurns: number },
  stdinText?: string,
  continuingRecord = false,
): void {
  try {
    spawnRun(run, resumeSessionId, tools, settings, stdinText, continuingRecord);
  } catch (err) {
    auditUnstartedSpawn(run.id);
    run.status = "failed";
    run.error = `Could not start ${CODING_HARNESS_COMMAND}: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
    run.completedAt = Date.now();
    // Nothing settles this run through finishRun either, so the tab a previous
    // attempt of the same record opened is closed here.
    cleanupRunResources(run, null);
    // …and a run that never started has ended: its one-run copies go too.
    endRunSecrets(run);
    // …and neither does the aftermath run, which is where a run's copy of the
    // project is normally decided. A run that never started left nothing on
    // its branch, so this removes both.
    trackSettleWork(settleRunWorktree(run));
    // The branch made for its pull request is already on the record. Nothing
    // settles the run through finishRun on this path, so the pull request is
    // ended here too, or it stays "opening" — pending — for good.
    if (isPrPending(run.pr)) {
      settlePr(run, "failed", `The run could not start, so no pull request was opened. Its branch ${run.pr?.branch ?? runBranchName(run.id)} is checked out.`);
    }
    persist(true);
    wakeWaiters(run.id);
    console.error(`[coding-agent] ${run.id} failed to spawn:`, err instanceof Error ? err.message : err);
    throw new CodingAgentError("not_ready", run.error);
  }
}

/**
 * Test hook: forget in-memory state so the next call re-reads the file, and
 * answer once the settle path has stopped touching the disk.
 *
 * Every clear stays synchronous — callers that reset mid-test and read the
 * module in the next line depend on that. The promise is the added half: a
 * teardown that removes the suite's temp tree must await it, or it races the
 * `git` a just-finished run is still spawning inside that tree. A run this
 * call kills counts too, which is why the children go to the drain — and so
 * does a run the chain being drained STARTS behind the sweep, which is why the
 * drain looks again rather than answering the first time `settling` empties.
 * See `drainForTests`.
 */
export function _resetCodingAgentStateForTests(): Promise<void> {
  const killed = endEveryLiveRun();
  if (store.flushTimer) {
    clearTimeout(store.flushTimer);
    store.flushTimer = null;
  }
  store.dirty = false;
  store.runs = null;
  store.signature = null;
  store.historyPolicy = null;
  // `exitHookInstalled` is deliberately LEFT set: the listener it guards is on
  // `process`, which this cannot take back, and it works against the shared
  // `live` map either way — clearing the flag would add one more listener per
  // test instead of reusing the one that is already there.
  // Module state like the rest: left set, it would refuse the next test file's
  // runs from a fault the box under test never had.
  liveHarnessFault = null;
  // A start this reset interrupted would otherwise leave its slot held for the
  // life of the process, which is a permanent discount on the limit.
  store.startingRuns = 0;
  store.startingTeams?.clear();
  if (store.queueRetry) clearTimeout(store.queueRetry);
  store.queueRetry = null;
  store.queuePumpAgain = false;
  // `anthropicResume` is left as it is: a pass still in flight must stay the
  // one the next pass waits for.
  return drainForTests(killed, SETTLE_DRAIN_BUDGET_MS);
}

/**
 * End everything that is live right now, and answer the children whose exit the
 * drain has to wait for. Split out of the reset because the reset has to do it
 * MORE THAN ONCE — see `drainForTests`.
 */
function endEveryLiveRun(): ChildProcess[] {
  const killed: ChildProcess[] = [];
  for (const state of live.values()) {
    clearTimeout(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
    if (state.streamTimer) clearInterval(state.streamTimer);
    if (state.unitWatch) clearInterval(state.unitWatch);
    // Said BEFORE the signal, like every other path that ends a run: the
    // owner's Stop and Pause and the token limit set `endRequested`, and the
    // idle timeout says the same thing with `timedOut`. Without it finishRun
    // reads the kill as the provider blinking — transient stderr, no file
    // touched, `endRequested === null` — and starts a REPLACEMENT child that
    // this drain neither killed nor waits for. `??=`, because the retry guard
    // is exactly `=== null`: a Stop or Pause already in flight is the owner's
    // gesture and must still settle as itself.
    state.endRequested ??= "stop";
    // The scope too: a suite must not leave a detached run of its own behind,
    // which is the one way this feature could leak a process past the test run.
    if (state.unit) void stopUnit(state.unit).catch(() => {});
    signalRun(state, "SIGKILL");
    if (state.child) killed.push(state.child);
  }
  live.clear();
  waiters.clear();
  store.unannounced.clear();
  transitions.clear();
  runSecretEnv.clear();
  runMcpPlan.clear();
  // What ends the watchers' loops: a poll already in flight is waited for by
  // the drain, and neither it nor a timer armed earlier polls again once its
  // run is gone from these — see `runWatcherPoll`.
  prWatchers.clear();
  reviewWatchers.clear();
  return killed;
}

/**
 * The teardown drain, swept until the box is actually quiet.
 *
 * One pass is not enough, because the chain this waits for is the chain that
 * STARTS runs: `reviewAndShip` awaits `maybeStartReviewPass`, which spawns the
 * automatic review pass, and `enforceDeliverable` resumes the record for
 * another attempt. Both register a brand-new live run — after `live` was swept,
 * so nothing killed it, and `settling` empties the moment the chain that
 * started it returns. `settleWork` then reported success with a harness process
 * still going, holding the previous test's module copy, its temp tree and every
 * shared mock in that file.
 *
 * What it cost: `coding-pipeline-driver.test.ts` and
 * `coding-agent-durable-completion.test.ts` failed in CI's full run and passed
 * on their own, the leaked run's finish notice landing in the NEXT test's
 * freshly cleared spy. Reproduced on demand under CPU load, and pinned by
 * `coding-agent-reset-drain.test.ts`.
 *
 * So: drain, then look again, and end whatever appeared behind the sweep. The
 * overall budget is unchanged — `settleWork` is handed what is left of it and
 * says so once, at the end, exactly as before.
 */
async function drainForTests(initial: ChildProcess[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  let killed = initial;
  while (left() > 0) {
    await settleWork(killed, left());
    if (live.size === 0 && settling.size === 0) return;
    if (left() === 0) return;
    killed = endEveryLiveRun();
    // A start this sweep interrupted must not keep its slot either.
    store.startingRuns = 0;
    store.startingTeams?.clear();
    // A live run with no child yet — a spawn caught mid-flight — gives
    // `settleWork` nothing to wait on, and it would answer at once. Give the
    // spawn a turn rather than spinning on it.
    if (killed.length === 0 && settling.size === 0) await wait(Math.min(REAP_POLL_MS, left()));
  }
}
