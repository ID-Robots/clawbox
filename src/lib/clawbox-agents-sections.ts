/**
 * ClawBox's sections of the OpenClaw workspace AGENTS.md, and the heartbeat's
 * way of putting them there.
 *
 * AGENTS.md is the file OpenClaw injects into every session ("a good place for
 * rules", docs/concepts/agent-workspace.md), so ClawBox appends its rules to
 * it. Before this module only scripts/gateway-pre-start.sh did, as the gateway's
 * ExecStartPre, and only to an AGENTS.md that already exists: it never creates
 * the file, the harness owns that. But OpenClaw 2026.11.5 creates AGENTS.md on
 * the agent's FIRST RUN (docs/cli/setup.md: "The Gateway seeds missing
 * workspace files on the agent's first run"), and on a freshly set-up box every
 * gateway start happens during the wizard, before that run. A new box therefore
 * ran without any of these rules until something restarted its gateway, which
 * can be days. That is the probe-once class: one look per gateway start, "no
 * file, nothing to do", trusted until the next start.
 *
 * So the five-minute heartbeat looks again and appends what is missing, through
 * OpenClaw's own bootstrap-file RPC (`agents.files.get` / `agents.files.set`,
 * docs/gateway/protocol/rpc-talk-config-and-agents.md) rather than a raw write
 * into a file the agent may be editing at that moment. The read's hash and
 * workspace go back as the write's preconditions. That check is best-effort in
 * the pinned docs' own words (docs/plugins/sdk-agent-harness/core-ownership.md:
 * writers outside the gateway's save queue are not serialised against it), and
 * a refused write is simply tried again on the next tick.
 *
 * The appended bytes and the "already there" test are pre-start's, byte for
 * byte: two writers that disagreed about whether a section is present would
 * give a box two copies of it. src/tests/unit/gateway-pre-start-workspace-guide.test.ts
 * runs both on the same files and compares the results, so a section added to
 * one copy only fails there.
 *
 * SERVER ONLY.
 */

import { createHash } from "crypto";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { getActiveHarness } from "@/lib/harness";
import { openclawWorkspaceDir } from "@/lib/language-persona";
import { openclawDefaultAgentId } from "@/lib/openclaw-default-agent";
import { GatewayRpcError, GatewayWsUnavailableError, gatewayWsCall } from "@/lib/openclaw-gateway-ws";

export interface ClawboxAgentsSection {
  /** The section's own heading, which is also its marker: matched as a whole line. */
  heading: string;
  /** Exactly what gateway-pre-start.sh appends when the heading is missing. */
  payload: string;
  /** The line pre-start prints after that append; the heartbeat logs the same one. */
  appendedLine: string;
}

function section(heading: string, paragraphs: string[], appendedLine: string): ClawboxAgentsSection {
  return { heading, payload: `\n\n${heading}\n\n${paragraphs.join("\n\n")}\n`, appendedLine };
}

/** In pre-start's order, which is the order they are appended in. */
export const CLAWBOX_AGENTS_SECTIONS: readonly ClawboxAgentsSection[] = [
  section("## ClawBox integration", [
    "See `CLAWBOX.md` for device-specific conventions: where user-installed skills live, how to control the "
      + "desktop Chromium via `browser_*` tools, how to install/uninstall skills through the App Store, and "
      + "which system actions are the owner's.",
  ], "Appended CLAWBOX.md reference to AGENTS.md"),
  section("## System actions on this ClawBox", [
    "Restarting the OpenClaw gateway is not yours to do from a chat turn: the gateway hosts this session, so "
      + "the restart kills the reply before it lands. It is rarely needed either — saving a setting under "
      + "Settings -> Providers, Voice or Channels restarts it. Say that, and name the setting.",
    "A device restart or shutdown IS yours when the owner asks in their own words: `system_power`, "
      + "`confirm: true`, with their reason. Their own control is the power menu in the desktop tray, not "
      + "Settings -> System.",
    "Never queue an `operator_approval` proposal for any of this. ClawBox renders no approval card, so a "
      + "queued proposal is shown to nobody; a parked one is answered with `openclaw approvals pending` / "
      + "`openclaw approvals resolve` from the Terminal app. `CLAWBOX.md` has the long form.",
  ], "Appended the system-actions rule to AGENTS.md"),
  section("## Voice notes on this ClawBox", [
    "A voice note or audio message that reaches you with no transcript (no `[Audio]` block, or a marker that "
      + "the audio could not be transcribed) means speech-to-text is not available on this ClawBox right now. "
      + "Do not just ask for text. Say that voice notes cannot be transcribed here yet, and how the owner "
      + "turns it on: Settings -> Local AI -> Whisper -> Install (transcribes on the box itself), or connect "
      + "ClawBox AI under Settings -> Providers for cloud transcription. Then answer anything they also typed, "
      + "and offer to carry on in text meanwhile.",
  ], "Appended the voice-notes rule to AGENTS.md"),
  section("## Thinking level on this ClawBox", [
    "How hard you think is your thinking level. The owner calls it reasoning effort and sets it with the effort "
      + "pill (brain icon) under the message box in the ClawBox chat. Your prompt does not state it: `Reasoning=` "
      + "in your Runtime section is only OpenClaw reasoning VISIBILITY (`/reasoning on|off|stream`: whether your "
      + "thinking is shown as a separate message), and it says nothing about whether or how hard you think.",
    "When asked what reasoning, effort or thinking level you use, call `session_status` with "
      + "`sessionKey: \"current\"` and no `model` (find it with `tool_search` if it is not among your tools), and "
      + "report the `think` value on its card. If you cannot read it, say so and never name a level you did not "
      + "read there. To change the level, point to the effort pill, not to `/reasoning` or `/think`.",
  ], "Appended the thinking-level rule to AGENTS.md"),
];

/** pre-start trims these, and only these, off the end of a line before it compares. */
const TRAILING_BLANKS = /[ \t\r]+$/;

/**
 * Which lines a code fence hides: `CLAWBOX_FENCE_AWK` in gateway-pre-start.sh,
 * in its LENIENT reading (no `strict`), which is the one it applies to the
 * owner's and the agent's files.
 *
 * A fence is ``` or ~~~ after fewer than four spaces. A closer is the next fence
 * of the same character with a run at least as long, and may carry an info
 * string; a fence of the other kind seen while one is open is neither. A fence
 * left open makes the file prose: nothing is hidden at all, so a quoted heading
 * counts as present rather than being appended on every pass.
 */
function hiddenLines(lines: string[]): boolean[] {
  const fences: { at: number; char: string; run: number }[] = [];
  lines.forEach((line, at) => {
    const indent = line.length - line.replace(/^ +/, "").length;
    const mark = line.slice(indent);
    if (indent >= 4 || !(mark.startsWith("```") || mark.startsWith("~~~"))) return;
    let run = 1;
    while (mark[run] === mark[0]) run++;
    fences.push({ at, char: mark[0], run });
  });
  const hidden: boolean[] = lines.map(() => false);
  const pairs: [number, number][] = [];
  let open: (typeof fences)[number] | null = null;
  for (const fence of fences) {
    if (!open) {
      open = fence;
      continue;
    }
    if (fence.char !== open.char || fence.run < open.run) continue;
    pairs.push([open.at, fence.at]);
    open = null;
  }
  if (open) return hidden;
  for (const [from, to] of pairs) for (let i = from; i <= to; i++) hidden[i] = true;
  return hidden;
}

/** `clawbox_file_has_heading`: `heading` as a whole line, outside a fence. */
function hasHeading(text: string, heading: string): boolean {
  const lines = text.split("\n").map((line) => line.replace(TRAILING_BLANKS, ""));
  const hidden = hiddenLines(lines);
  return lines.some((line, i) => !hidden[i] && line === heading);
}

/**
 * Each section in turn, tested against the text as the earlier appends left it,
 * as pre-start tests the file again before every append.
 */
function appendMissing(text: string): { text: string; appended: ClawboxAgentsSection[] } {
  const appended: ClawboxAgentsSection[] = [];
  let out = text;
  for (const s of CLAWBOX_AGENTS_SECTIONS) {
    if (hasHeading(out, s.heading)) continue;
    out += s.payload;
    appended.push(s);
  }
  return { text: out, appended };
}

/** AGENTS.md with every ClawBox section it lacks appended, exactly as gateway-pre-start.sh appends them. */
export function withClawboxAgentsSections(text: string): string {
  return appendMissing(text).text;
}

const AGENTS_MD = "AGENTS.md";

/**
 * One journal line per reason for as long as the server runs. A box that cannot
 * be written (a moved workspace, an agent the gateway does not know) would
 * otherwise say the same thing 288 times a day.
 */
const noted = new Set<string>();
function noteOnce(reason: string, message: string): void {
  if (noted.has(reason)) return;
  noted.add(reason);
  console.warn(`[agents-md] ${message}`);
}

/** The text of AGENTS.md, or null when there is none to append to. Never creates it. */
async function readAgentsMd(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      noteOnce("not-a-file", `${file} exists and is not a regular file; leaving it as it is`);
      return null;
    }
    return await fs.readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      noteOnce("unreadable", `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function appendMissingSections(): Promise<void> {
  try {
    if ((await getActiveHarness()) !== "openclaw") return;

    // A cheap look on disk first, so the ticks with nothing to do (all of them,
    // once the sections are in) make no gateway call.
    const workspace = openclawWorkspaceDir();
    const onDisk = await readAgentsMd(path.join(workspace, AGENTS_MD));
    if (onDisk === null || withClawboxAgentsSections(onDisk) === onDisk) return;

    // The agent the config names, never "main" by assumption: the gateway
    // refuses an id its config does not have (TASK-2248's box names its agent
    // `default`), and every tick would fail there.
    const agentId = await openclawDefaultAgentId();
    let read: Record<string, unknown>;
    try {
      read = await gatewayWsCall("agents.files.get", { agentId, name: AGENTS_MD });
    } catch (err) {
      // Straight to the socket, not callGatewayRpc: its CLI fallback is a
      // 10-12 s cold start on a Jetson on every tick while the gateway is down,
      // with the whole file on its argv. A gateway that is down runs pre-start
      // when it comes back, and that appends the same sections.
      if (err instanceof GatewayWsUnavailableError) return;
      throw err;
    }

    const file = asRecord(read.file);
    if (file?.missing === true) return;
    const gatewayWorkspace = read.workspace;
    // Without a hash the write below would be an unconditional overwrite of a
    // file the agent may have just changed.
    if (typeof file?.content !== "string" || typeof file.hash !== "string" || typeof gatewayWorkspace !== "string") {
      noteOnce("shape", "agents.files.get answered without the content, hash or workspace; not writing AGENTS.md");
      return;
    }
    if (path.resolve(gatewayWorkspace) !== path.resolve(workspace)) {
      noteOnce(
        "workspace",
        `the gateway's workspace (${gatewayWorkspace}) is not ${workspace}; not writing its AGENTS.md`,
      );
      return;
    }
    // The gateway decodes the file leniently, so bytes that are not UTF-8 would
    // come back from this write as U+FFFD. pre-start appends bytes, so leave
    // such a file to the next gateway start.
    if (createHash("sha256").update(file.content, "utf8").digest("hex") !== file.hash) {
      noteOnce("decode", "AGENTS.md is not plain UTF-8; leaving it to the gateway's next start");
      return;
    }

    const { text: next, appended } = appendMissing(file.content);
    if (appended.length === 0) return;
    await gatewayWsCall("agents.files.set", {
      agentId,
      name: AGENTS_MD,
      content: next,
      expectedHash: file.hash,
      expectedWorkspace: gatewayWorkspace,
    });
    // Only now: these are the lines an operator greps the journal for.
    for (const s of appended) console.log(`[agents-md] ${s.appendedLine}`);
  } catch (err) {
    // A conflict (the agent wrote AGENTS.md since the read) arrives as a plain
    // INVALID_REQUEST: the client keeps no details. Every refusal is the same
    // answer, the next tick reads again.
    const reason = err instanceof GatewayRpcError ? `rpc:${err.code}` : err instanceof Error ? err.name : "error";
    const detail = err instanceof Error ? err.message : String(err);
    noteOnce(reason, `could not append ClawBox's sections to AGENTS.md (the next tick tries again): ${detail}`);
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Append every ClawBox section AGENTS.md lacks, while OpenClaw is the harness.
 *
 * One run at a time. A run is short: at most two gateway calls, each capped at
 * 1.5 s to connect and 10 s to answer (openclaw-gateway-ws.ts), so about 23 s,
 * far inside the five-minute interval. What the guard covers is two callers in
 * that window: a manual call of the tick, or a tick started while the previous
 * tick's un-awaited run is still inside its calls. Two overlapping runs would
 * only cost each other a conflict. Never rejects. A heading the owner or the
 * agent deleted comes back on the next tick, as it already did on every
 * gateway start.
 */
export function ensureClawboxAgentsSections(): Promise<void> {
  inFlight ??= appendMissingSections().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
