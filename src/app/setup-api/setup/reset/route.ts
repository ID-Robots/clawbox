import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { padResponseTime } from "@/lib/login-rate-limit";
import {
  checkReproveLockout,
  lockoutBuckets,
  reproveOwnerPassword,
} from "@/lib/password-reprove";
import { resetUpdateState } from "@/lib/updater";
import { DATA_DIR } from "@/lib/config-store";
import { CLAWKEEP_DATA_DIR } from "@/lib/clawkeep";
import { getSystemUsername } from "@/lib/auth";
import { CHPASSWD_INPUT_PATH, CHPASSWD_SERVICE_NAME, CHPASSWD_STEP, chpasswdRecord } from "@/lib/chpasswd";
import { FACTORY_DEFAULT_PASSWORD } from "@/lib/system-password";
import { FACTORY_RESET_CONFIRMATION, isFactoryResetConfirmed } from "@/lib/factory-reset";
import { readEdition } from "@/lib/edition-source";
import { startOllamaService } from "@/lib/local-ai-runtime";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import crypto from "crypto";
import { startRootStep } from "@/lib/root-step-runner";
import { readDesktopBrowserConfig } from "@/lib/desktop-browser-config";
import { clientTimedOut, readUnitState, runUnitJob, unitIsStopped, type UnitState } from "@/lib/gateway-unit-job";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
const OPENCLAW_DIR = "/home/clawbox/.openclaw";

// Entries under DATA_DIR that survive a factory reset. A `keep` set means the
// entry survives this top-level pass as a CONTAINER only and is then wiped
// entry-by-entry down to those names; without one it is kept as it is.
const DATA_KEEP: ReadonlyArray<{ rel: string; keep?: ReadonlySet<string> }> = [
  // Hardware-specific and auto-generated.
  { rel: "network.env" },
  {
    // models/ holds the 3.2 GB offline Gemma GGUF — the same category as the
    // ~/.cache/huggingface voice models the home wipe keeps below: a reset
    // device reboots into AP mode with no internet, so a deleted model cannot
    // be re-downloaded and the box comes up with no on-device AI at all.
    // Weights are pure cache, not owner state — no tokens, no chats, no
    // prompts — so keeping them hands the next owner nothing. (It also carries
    // ~24 KB of `hf` download bookkeeping; re-check that if huggingface_hub
    // ever starts caching credentials under a --local-dir.)
    //
    // Its siblings are a different matter: llamacpp/ is also llama-server's
    // runtime scratch (server.pid, server.log), and a log of a LOCAL MODEL is
    // owner-adjacent by nature. The shipped server config keeps prompt text
    // out of that log today; narrowing the keep to models/ is what makes that
    // stay true when the config changes.
    //
    // Same KNOWN RESIDUAL as the ~/.hermes exception below, with the same
    // verdict: a previous owner with a shell can plant a file in a preserved
    // directory and it survives the reset.
    rel: "llamacpp",
    keep: new Set(["models"]),
  },
  {
    // The memory-search embedder's GGUF (639 MB), for the same reason as the
    // Gemma one above: a reset box has no internet to fetch it again, and
    // weights are cache, not owner state. Its server.log is wiped with the
    // rest — that log is of the owner's own documents being embedded.
    rel: "embed",
    keep: new Set(["models"]),
  },
];
const DATA_KEEP_NAMES = new Set(DATA_KEEP.map((entry) => entry.rel));

// The named exceptions to the ~/.hermes wipe. None is owner state and none can
// be re-fetched on a reset device — it reboots into AP mode with no internet.
// Rationale for each is at the HOME_CONTENT_WIPE_KEEP entry below.
const HERMES_KEEP = new Set(["hermes-agent", "bin", "installs", "tools"]);

/** Delete all Ollama models so a factory reset starts with a clean slate. */
async function deleteOllamaModels(): Promise<void> {
  // Deliberately the loopback address, not getOllamaBaseUrl(): that one honours
  // OLLAMA_HOST, and a factory reset must never issue /api/delete against
  // somebody else's Ollama server. What this cleans is the models this device
  // downloaded, which live under /usr/share/ollama on the device itself.
  const OLLAMA = "http://127.0.0.1:11434";
  // Ollama is routinely STOPPED at reset time (the Local AI exclusive-mode
  // runtime shuts it down while llama.cpp is active), and its models live
  // under /usr/share/ollama — out of reach of the home wipe. Start it
  // best-effort so the API deletes below actually run.
  //
  // Through startOllamaService() rather than a hand-rolled systemctl call. This
  // used to be a bare `systemctl start ollama` with no sudo, which worked only
  // because of the unscoped polkit `manage-units` grant — the one thing that
  // still makes the whole allow-list bypassable (TASK-539). The moment that
  // grant goes, an unprivileged call here fails with "Interactive
  // authentication required" and factory reset stops deleting models, silently.
  // The shared helper already spells the unit `ollama.service` (sudoers matches
  // arguments exactly, so the bare name matches nothing), passes `-n` so a box
  // without the grant fails in milliseconds instead of sitting on a prompt,
  // keeps the unprivileged call as a dev-shell fallback, and waits for the API
  // to answer — which is what the retry loop here used to approximate. TASK-445.
  try {
    await startOllamaService();
  } catch {
    // Not installed / never came up — the fetch below decides what's cleanable.
  }
  let models: { name: string }[] = [];
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return;
    const data = await res.json();
    models = data.models ?? [];
  } catch {
    return; // nothing reachable to clean
  }
  for (const { name } of models) {
    try {
      await fetch(`${OLLAMA}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[Reset] Deleted Ollama model: ${name}`);
    } catch (err) {
      console.warn(`[Reset] Failed to delete Ollama model '${name}':`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Delete all saved WiFi connections from NetworkManager, including the
 * hotspot profile. Without this, the device auto-reconnects to a saved
 * network after reboot (bypassing AP/captive-portal mode), and the previous
 * hotspot password stays saved in the ClawBox-Setup profile.
 *
 * nmcli TYPE column varies by version ("wifi" modern, "802-11-wireless"
 * older) — match both.
 */
async function deleteWifiConnections(): Promise<void> {
  const { stdout } = await execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], {
    timeout: 10_000,
  });
  const wifiNames = new Set<string>();
  for (const line of stdout.trim().split("\n")) {
    const match = line.match(/^(.*):(?:wifi|802-11-wireless)$/);
    if (match) wifiNames.add(match[1]);
  }
  // Always attempt to delete the hotspot profile even if it didn't appear in
  // the listing, so a stored password from a renamed/stale connection can't
  // survive a factory reset.
  wifiNames.add("ClawBox-Setup");

  for (const name of wifiNames) {
    await execFile("nmcli", ["connection", "delete", name], { timeout: 10_000 }).catch((err) => {
      console.warn(`[Reset] Failed to delete WiFi connection '${name}':`, err instanceof Error ? err.message : err);
    });
  }
  if (wifiNames.size > 0) {
    console.log(`[Reset] Deleted ${wifiNames.size} WiFi connection(s) (including hotspot)`);
  }
}

/** ENOENT, the one errno every step of this wipe reads as "already gone". */
function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

/**
 * What `removeDirectoryContents` is allowed to do with `dir`.
 *
 * `directory` — it really is one; readdir it.
 * `gone`      — there was nothing there, or what was there was not a directory
 *               and has been removed. Nothing was hidden behind it.
 * `failure`   — say so through the failure list. NEVER a throw: everything else
 *               in this wipe returns its failures, and the handler's outer catch
 *               is a 500 taken AFTER data/, ~/.openclaw, ~/.clawkeep and the
 *               home paths are gone and BEFORE the password reset, the WiFi
 *               clear and the reboot — the un-resettable box this whole guard
 *               exists to prevent, reached by a different errno.
 */
type DirectoryGuard =
  | { kind: "directory" }
  | { kind: "gone" }
  | { kind: "failure"; failure: string };

/**
 * Check what `dir` actually is before anything readdirs it.
 *
 * Nothing may `readdir` a path this wipe is about to empty entry-by-entry until
 * this has answered `directory`. A previous owner with a shell (the Terminal
 * app, or SSH before the key wipe — the adversary the keep-lists are written
 * against) can leave two things in the way:
 *
 *   - A SYMLINK. `readdir` follows it and `fs.rm` then deletes THROUGH it:
 *     `rm -rf ~/.hermes && ln -s /home/clawbox ~/.hermes` turned the next
 *     owner's factory reset into a wipe of everything in the home directory
 *     that is not a keep-list NAME — the checkout, `.bun`, `.local/bin`, the
 *     `~/.cache/huggingface` voice models. A reflash, caused by pressing
 *     Factory reset.
 *   - A PLAIN FILE. `readdir` raises ENOTDIR, which used to escape to the
 *     handler's outer catch and answer 500 half-way through the wipe,
 *     identically on every retry.
 *
 * Both are answered by removing THAT PATH — `fs.rm` on a symlink removes the
 * link, never its target — but they are not the same outcome and must not be
 * reported as one:
 *
 *   - A plain file (or socket, or fifo) hid nothing: there is no directory of
 *     owner state behind it, so removing it finishes the job (`gone`) and the
 *     reset completes, which is the ENOTDIR half of the defect.
 *   - A SYMLINK hid everything. Its target still holds whatever the wipe was
 *     sent to erase — and it may not even be on this disk. Deleting through it
 *     is the reflash above; keeping quiet about it would hand the next owner a
 *     box that answered "factory reset complete" over a `~/Documents` still
 *     full of the previous owner's files, browsable in the Files app. So the
 *     link goes and the path is REPORTED: the handler's aggregate gate then
 *     answers "factory reset incomplete" with the path named, WITHOUT clearing
 *     the WiFi, resetting the password or rebooting, so the owner still has a
 *     reachable box and something to act on.
 *
 * That also covers a directory that is a symlink for a good reason — a
 * `data/llamacpp` moved to another disk, say. Its `keep` list (the 3.2 GB Gemma
 * GGUF) is unreachable through a removed link, so "nothing inside a
 * non-directory can be a keep-list member" is true of a plain file and NOT of a
 * symlink; reporting is what stops that becoming a silent loss on a box that
 * reboots into AP mode with no internet.
 *
 * Not TOCTOU-proof, deliberately: Node exposes no readdir-at-fd (`fs.opendir`
 * takes a path, there is no `fdopendir`), so a shell racing this between the
 * lstat and the readdir could still swap a directory for a link. That needs a
 * live adversary on the box DURING the reset; the planted-link case closed here
 * needs a shell once, at any time before it.
 */
async function guardDirectory(dir: string): Promise<DirectoryGuard> {
  let stats;
  try {
    stats = await fs.lstat(dir);
  } catch (err: unknown) {
    if (isEnoent(err)) return { kind: "gone" };
    return { kind: "failure", failure: `${dir}: ${err}` };
  }
  if (stats.isDirectory()) return { kind: "directory" };

  const wasSymlink = stats.isSymbolicLink();
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err: unknown) {
    return { kind: "failure", failure: `${dir}: ${err}` };
  }
  if (!wasSymlink) return { kind: "gone" };
  return {
    kind: "failure",
    failure: `${dir}: a symlink, not a directory — the link was removed and whatever it pointed at was left untouched, so this factory reset did not erase it`,
  };
}

/**
 * Name a failure from `removeDirectoryContents` for the aggregate list.
 *
 * An ENTRY failure is a bare name (`auth.json: EACCES…`) and is read relative to
 * the directory it came from; a WHOLE-DIRECTORY failure from `guardDirectory`
 * already carries its absolute path, and prefixing that again would read as a
 * child of itself.
 */
function labelFailure(rel: string, failure: string): string {
  return failure.startsWith("/") ? failure : `${rel}/${failure}`;
}

async function removeDirectoryContents(dir: string, keep?: ReadonlySet<string>): Promise<string[]> {
  // Background processes (npm install, plugin runtimes) can recreate files
  // between readdir and rm; one retry catches that.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Re-asked on every attempt, not hoisted: the retry exists because things
    // move under this wipe, and a path that became a link between the passes
    // must not be read through — or reported clean — on the second one either.
    const guard = await guardDirectory(dir);
    if (guard.kind === "gone") return [];
    if (guard.kind === "failure") return [guard.failure];
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
      if (keep) entries = entries.filter((entry) => !keep.has(entry));
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }
    if (entries.length === 0) return [];
    const results = await Promise.allSettled(
      entries.map(entry => fs.rm(path.join(dir, entry), { recursive: true, force: true }))
    );
    const failures = results
      .map((r, i) => r.status === "rejected" ? `${entries[i]}: ${r.reason}` : null)
      .filter((f): f is string => f !== null);
    if (failures.length === 0) return [];
    if (attempt === 0) {
      console.warn(`[Reset] ${failures.length} item(s) in ${dir} survived first pass — retrying:`, failures);
      continue;
    }
    console.warn(`[Reset] Failed to remove ${failures.length} item(s) in ${dir}:`, failures);
    return failures;
  }
  return [];
}


// Mask + stop is mandatory: with just `stop`, systemd's `Restart=always`
// auto-restarts the gateway within milliseconds, so the gateway then
// recreates plugin-runtime-deps mid-`fs.rm` and the wipe leaves stragglers.
// Mask blocks the auto-restart for the rest of this boot. Unmasked before
// reboot so the next boot brings the gateway back cleanly.
// The Hermes SKU ships no OpenClaw gateway at all: install.sh stops, disables
// and (persistently) masks it, and ~/.openclaw is empty, so there is no
// Restart=always race to protect the wipe from. Running the mask/unmask dance
// there is pure noise — and the unmask on the way out would be actively wrong,
// since it would clear the persistent mask that keeps an unauthenticated agent
// gateway off the LAN on that SKU.
function gatewayIsPartOfThisEdition(): boolean {
  return readEdition() !== "hermes";
}

async function maskAndStopGateway(): Promise<void> {
  if (!gatewayIsPartOfThisEdition()) return;
  // `--runtime` writes the mask symlink to /run/systemd/system/, which takes
  // precedence over the real unit file at /etc/systemd/system/. Plain `mask`
  // would refuse with "File … already exists." for /etc/-installed units.
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "--runtime", "mask", "clawbox-gateway.service"], { timeout: 10_000 });
  } catch (err) {
    console.warn("[Reset] Failed to mask gateway:", err instanceof Error ? err.message : err);
  }
  // Waited for on the unit when the stop outlives its client: on an x64 bridge
  // it waits for OpenClaw's own drain, and the wipe must not start beside a
  // gateway that is still writing its state. A gateway still stopping, or not
  // stopped at all, ends the reset here, before anything is wiped; the caller's
  // catch unmasks it, asks systemd to start it again when the stop is still
  // under way, and answers in these words. The waits are bounded so that answer
  // reaches the page: the tunnel cuts a request at about 100 s (worst case
  // here: mask 10 + client 15 + settle 45 + show 10 + unmask 10 + restart 5),
  // and a reset that wiped minutes after the page showed a network error would
  // be a failure reported over a reset that happened.
  const stopAskedAt = Date.now();
  let state: UnitState | null = null;
  let stillStopping = false;
  try {
    const stop = await runUnitJob("/usr/bin/sudo", ["/usr/bin/systemctl", "stop", "clawbox-gateway.service"], {
      unit: "clawbox-gateway.service",
      timeoutMs: 15_000,
      settleBudgetMs: 45_000,
    });
    if (stop.kind === "in-flight") stillStopping = true;
    else if (stop.kind === "settled") state = stop.state;
  } catch (err) {
    // A stop that failed outright (a refused sudo, a stop cancelled by a
    // restart someone else queued) proves nothing either way, so the unit is
    // asked. A unit that cannot be asked either may still be running, and the
    // wipe is not started on a guess: a restart of the device is the way back.
    console.warn("[Reset] Failed to stop gateway before wipe:", err instanceof Error ? err.message : err);
    state = await readUnitState("clawbox-gateway.service");
    if (!state) {
      throw new GatewayNotStoppedError(
        "The factory reset was not started because the assistant could not be confirmed stopped. Nothing was erased; restart the device and try again.",
        false,
      );
    }
  }
  if (state && !unitIsStopped(state)) {
    if (state.activeState === "deactivating") stillStopping = true;
    else throw new GatewayNotStoppedError("The assistant did not stop, so the factory reset was not started. Nothing was erased.", false);
  }
  if (stillStopping) {
    const waitedS = Math.round((Date.now() - stopAskedAt) / 1000);
    throw new GatewayNotStoppedError(
      `The assistant was still stopping after ${waitedS}s, so the factory reset was not started. Nothing was erased.`,
      true,
    );
  }
}

/** The reset ended before anything was erased because the gateway had not stopped. */
class GatewayNotStoppedError extends Error {
  constructor(message: string, readonly stillStopping: boolean) {
    super(message);
    this.name = "GatewayNotStoppedError";
  }
}

/**
 * Put back a gateway this reset stopped and then did not wipe beside. The stop
 * it asked for runs on after its client was killed, and an explicit stop is
 * one `Restart=always` does not undo, so without this the assistant stays down
 * until the box restarts. systemd queues the restart behind the running stop
 * and starts the unit once its deactivation ends. A refusal (a masked unit, a
 * refused sudo) comes back at once; a client still waiting at its deadline
 * means systemd took the job, which is what answers true.
 */
async function startGatewayAgain(): Promise<boolean> {
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"], { timeout: 5_000 });
    return true;
  } catch (err) {
    if (clientTimedOut(err)) return true;
    console.warn("[Reset] Failed to start the gateway again:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Whether the gateway is unmasked afterwards (true where this edition has none). */
async function unmaskGateway(): Promise<boolean> {
  if (!gatewayIsPartOfThisEdition()) return true;
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "--runtime", "unmask", "clawbox-gateway.service"], { timeout: 10_000 });
    return true;
  } catch (err) {
    console.warn("[Reset] Failed to unmask gateway:", err instanceof Error ? err.message : err);
    return false;
  }
}

const HOME_DIR = process.env.HOME || "/home/clawbox";

// Personal state OUTSIDE data/ and ~/.openclaw that a used device accumulates.
// Removed entirely on factory reset. A REMOVE-list (not a KEEP-list) on
// purpose: a stale entry here is a no-op (`force: true`), while a wrong
// KEEP-list would delete bun/openclaw/voice models on a box that reboots
// into AP mode with no internet to re-download them — a reflash.
const HOME_REMOVE_PATHS = [
  // authorized_keys would let the previous owner SSH back in even after the
  // password reset below; private keys/known_hosts identify the prior owner.
  ".ssh",
  // OAuth tokens synthesized by gateway-pre-start.sh for the codex app-server.
  ".codex",
  // AI-browser Chromium profile: cookies, logged-in sessions, history
  // (PROFILE in scripts/launch-browser.sh). A profile of the owner's own that
  // they pointed the app at goes too — configuredBrowserProfile() below.
  ".config/clawbox-browser",
  // The launch env file: the previous owner's start page, and which browser
  // profile, port and executable of theirs the app was pointed at.
  ".cache/clawbox/browser.env",
  // Pictures the owner pasted into the Terminal (src/lib/terminal-paste-store.ts):
  // screenshots of whatever was on their screen. The store's own pruning runs
  // only when another picture is pasted, so a reset is what must take them.
  ".cache/clawbox/terminal-paste",
  // Shell/REPL histories and identity the TerminalApp + agent run_command
  // accumulate; .netrc/.npmrc can carry plaintext credentials.
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".lesshst",
  ".viminfo",
  ".wget-hsts",
  ".gitconfig",
  ".netrc",
  ".npmrc",
  // `hf auth login` token — surgical file removals; the surrounding
  // ~/.cache/huggingface keeps the as-flashed Whisper/Kokoro voice models,
  // which can't be re-downloaded once the box is back in AP mode.
  ".cache/huggingface/token",
  ".cache/huggingface/stored_tokens",
  // VS Code server state/extensions from the VSCode app.
  ".local/share/code-server",
];
// User-visible folders the Files app exposes (and recreates empty on demand):
// wipe the contents, keep the directories.
//
// Projects is the coding agent's default work folder — the owner's code, their
// repositories and every app the agent built for them — and the rest are the
// standard XDG user folders. They used to be missing from this list, so a reset
// box handed the next owner the previous one's projects, music, pictures and
// videos.
const HOME_CONTENT_WIPE_DIRS = [
  "Documents",
  "Downloads",
  "Desktop",
  "Projects",
  "Music",
  "Pictures",
  "Videos",
  "Public",
  "Templates",
];

// Directories wiped entry-by-entry with a NAMED exception list. Same
// remove-everything default as HOME_REMOVE_PATHS — the exception is spelled
// out and justified, and anything new that appears in the directory is
// removed by default rather than kept by default.
const HOME_CONTENT_WIPE_KEEP: ReadonlyArray<{ rel: string; keep: ReadonlySet<string> }> = [
  {
    // Hermes edition state — the Hermes equivalent of ~/.openclaw, and the
    // single biggest thing a resold box could hand its next owner: config.yaml
    // (billing token, the dashboard session SIGNING SECRET, the scrypt
    // password_hash), config.yaml.bak-*, .env (~24 KB of provider keys),
    // auth.json (OAuth tokens), memories/, logs/, cron/, pairing/, sessions/,
    // skills/ and the state/projects SQLite files. All of it still goes: this
    // is a wipe with ONE exception, not a keep-list.
    //
    // That exception is hermes-agent/, and it is not owner state at all. It is
    // the AGENT INSTALL — a git checkout of NousResearch/hermes-agent plus (up
    // to v0.21.1) the Python venv that ~/.local/bin/hermes (a 4-line shim)
    // execs; from v0.21.7 that venv and its interpreter moved, see below. Deleting it
    // was the factory-reset defect this exception fixes: the shim survives the
    // wipe (it lives in ~/.local/bin), so a reset box was left with a `hermes`
    // command whose interpreter no longer existed:
    //   ~/.local/bin/hermes: line 4:
    //   ~/.hermes/hermes-agent/venv/bin/python: No such file or directory
    // …and clawbox-hermes-dashboard.service (Restart=always) crash-looping on
    // status 127 forever. Nothing at boot reinstalls it, and a reset device is
    // in AP mode with no internet to re-download it — a reflash.
    //
    // It carries no secrets to leak: upstream source and a venv, byte-identical
    // on every box of this SKU.
    //
    // KNOWN RESIDUAL, accepted deliberately: a previous owner with a shell
    // could plant a file inside a preserved directory and it would survive the
    // reset. For bin/tirith that residual is sharper than for the checkout —
    // the agent EXECUTES that file before every shell command and its exit code
    // decides whether the command runs — but it is not made worse by keeping
    // the directory rather than the file: a planted `tirith` survives either
    // way, and nothing on the device can tell a genuine release binary from a
    // replacement without a trusted checksum it does not have offline. That is
    // also why the dashboard's scan status reports "installed and enabled", not
    // "your commands are being checked" (src/lib/hermes-shell-scan.ts). The obvious guard — wipe the checkout unless `git
    // status --porcelain` is empty — was tried and rejected. Both of its
    // outcomes are worse than the hole: wiping a "dirty" checkout recreates
    // this very brick on every box of the SKU at once the day upstream starts
    // writing into its own checkout (whether it stays pristine is
    // NousResearch's choice, not ours), and reporting it as a failure instead
    // aborts the reset (500, no reboot) so the box cannot be reset at all. It
    // would not stop the attacker either: the same shell can add the payload
    // to .git/info/exclude or drop it in venv/, gitignored upstream and
    // invisible to --porcelain. Re-provisioning the agent from upstream after
    // a reset is the real fix, and it needs network this device does not have
    // at reset time.
    //
    // From Hermes v0.21.7 the agent install is no longer one directory. The
    // upstream package manager builds the agent's venv in installs/ (selected by
    // installs/<key>/facts.json) and keeps the Python the launcher execs, plus
    // uv, node and the agent's browser, in tools/; ~/.local/bin/hermes now
    // execs a launcher in hermes-agent/.hermes/bin that runs
    // tools/python-<version>/bin/python3. Kept with hermes-agent/ for the same
    // reason: measured on a Nano, leaving out tools/ makes `hermes` fail with
    // "python3: not found", and leaving out installs/ leaves it no
    // dependencies. Both are upstream artifacts — hashes, interpreters,
    // packages — with no owner data in them.
    //
    // The second exception is bin/, and it is the same category. It holds the
    // upstream `tirith` binary the agent runs BEFORE every shell command
    // (Hermes' own `security.tirith_*` keys configure it). tirith is not
    // shipped with the box: the agent downloads it from a GitHub release into
    // $HERMES_HOME/bin the first time it is needed, and upstream's default is
    // fail-OPEN, so a box without it runs shell commands UNSCANNED. Wiping it
    // therefore handed the next owner an agent with its pre-exec safety check
    // silently off, for as long as the box stayed in AP mode — and a failed
    // download then writes ~/.hermes/.tirith-install-failed, which suppresses
    // the retry for another 24 h. That marker is NOT kept, so the reset clears
    // it and the next download attempt is immediate.
    //
    // Kept whole rather than narrowed to bin/tirith, deliberately. Narrowing
    // would mean wiping the directory entry-by-entry, and the only thing that
    // buys is removing files beside tirith that nothing on the box executes —
    // ~/.hermes/bin is not on the agent's PATH. What it costs is real: nothing
    // here has an authoritative inventory of that directory (ClawKeep's
    // archiver calls it a virtualenv, `clawkeep/clawkeep/hermes.py`), so a
    // narrow keep would delete whatever else upstream puts there, on every box
    // of the SKU at once, with no internet to restore it. Same argument the
    // `git status --porcelain` guard was rejected on above.
    //
    // Re-provisioning of the removed state is automatic: the dashboard unit
    // runs scripts/setup-hermes-dashboard-auth.sh as an ExecStartPre, which
    // recreates config.yaml and a fresh password/hash/signing-secret on the
    // next boot.
    //
    // Wiping entry-by-entry rather than `rm -rf ~/.hermes` also makes the reset
    // survivable: each child is removed independently, so one undeletable entry
    // is reported as a failure instead of aborting the whole subtree with the
    // agent already half deleted.
    rel: ".hermes",
    keep: HERMES_KEEP,
  },
];

// Loose files directly in the home root — a ~/notes.txt, an export saved next
// to the folders above, whatever the agent wrote there. Nothing listed them, so
// a reset box used to hand them to the next owner. Wiped with a NAMED exception
// list, the same remove-everything default as HOME_CONTENT_WIPE_KEEP: a file
// that appears here tomorrow is removed unless somebody adds it below.
//
// Regular files ONLY. The directories in the home root (the ClawBox checkout,
// llama.cpp/, .npm-global, .bun, .local, .cache …) are what the box runs on and
// stay with the lists above, and a symlink is left as it is.
const HOME_ROOT_FILE_KEEP = new Set([
  // The shell start-up files from /etc/skel. install.sh appends the
  // ~/.npm-global/bin and ~/.local/bin PATH entries to .bashrc, and the
  // Terminal's login shell reaches it through .profile: without them `claude`,
  // `codex`, `openclaw` and `hermes` are not found, and nothing on a reset box
  // writes them back.
  ".bashrc",
  ".profile",
  ".bash_logout",
  // Sourced by the X session at login.
  ".xsessionrc",
  // Ubuntu's marker that silences the sudo hint on every login shell.
  ".sudo_as_admin_successful",
]);

/**
 * Remove the loose regular files directly in the home root, except
 * HOME_ROOT_FILE_KEEP. Same failure contract as removeDirectoryContents: a
 * survivor is reported, never thrown.
 */
async function removeLooseHomeFiles(): Promise<string[]> {
  let names: string[];
  try {
    const entries = await fs.readdir(/* turbopackIgnore: true */ HOME_DIR, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && !HOME_ROOT_FILE_KEEP.has(entry.name))
      .map((entry) => entry.name);
  } catch (err: unknown) {
    if (isEnoent(err)) return [];
    return [`${HOME_DIR}: ${err}`];
  }
  // No `recursive`: a file swapped for a directory after the readdir fails to
  // remove and is reported, rather than taking a directory with it.
  const results = await Promise.allSettled(
    names.map((name) => fs.rm(path.join(HOME_DIR, name), { force: true })),
  );
  const failures = results
    .map((r, i) => r.status === "rejected" ? `${names[i]}: ${r.reason}` : null)
    .filter((f): f is string => f !== null);
  if (failures.length > 0) {
    console.warn(`[Reset] Failed to remove ${failures.length} file(s) in ${HOME_DIR}:`, failures);
  }
  return failures;
}

/**
 * The owner's own browser profile, when they pointed the Browser app at one
 * (CLAWBOX_BROWSER_PROFILE_DIR, src/lib/desktop-browser-config.ts), relative
 * to the home — removed for the reason ClawBox's own profile is: it holds
 * their cookies and signed-in sessions.
 *
 * Guarded, because the path came from a file the owner edits by hand: only a
 * directory strictly inside the home, and only a real Chromium profile — one
 * with a `Local State` file at its root. A typo that names `~/.config` or the
 * home itself is skipped and logged, never removed. Read BEFORE the wipe,
 * which removes the file that names it.
 *
 * Judged on the RESOLVED path, not the one written: `~/link/Profile` with
 * `link` pointing outside the home is lexically inside it, and `fs.rm` would
 * follow that symlink and delete a profile that is not in the home at all.
 * What is returned is the resolved location, relative to the resolved home,
 * so the removal names exactly the directory that was checked.
 */
async function configuredBrowserProfile(): Promise<string | null> {
  const config = await readDesktopBrowserConfig();
  if (config.ownProfile) return null;
  let home: string;
  let profile: string;
  try {
    // turbopackIgnore: a path the build cannot evaluate would otherwise be
    // traced as "any file in the project" and walk data/ (runtime-path.ts).
    [home, profile] = await Promise.all([
      fs.realpath(/* turbopackIgnore: true */ HOME_DIR),
      fs.realpath(/* turbopackIgnore: true */ config.profileDir),
    ]);
  } catch {
    console.warn("[Reset] The configured browser profile could not be resolved; not removing it");
    return null;
  }
  const rel = path.relative(home, profile);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    console.warn("[Reset] Leaving the configured browser profile outside the home directory in place");
    return null;
  }
  try {
    await fs.access(/* turbopackIgnore: true */ path.join(profile, "Local State"));
  } catch {
    console.warn("[Reset] The configured browser profile has no Local State file; not removing it");
    return null;
  }
  return rel;
}

/**
 * Wipe previous-owner state from the home directory so a factory-reset
 * device matches a fresh flash, not just a fresh ClawBox config. Returns
 * failure strings (same contract as removeDirectoryContents) — a survivor
 * in ~/.ssh is a security problem the caller must surface, not swallow.
 */
async function wipeHomeUserState(): Promise<string[]> {
  const failures: string[] = [];
  const ownerProfile = await configuredBrowserProfile();
  const removePaths = ownerProfile ? [...HOME_REMOVE_PATHS, ownerProfile] : HOME_REMOVE_PATHS;
  await Promise.all(
    removePaths.map((rel) =>
      fs.rm(path.join(HOME_DIR, rel), { recursive: true, force: true }).catch((err) => {
        failures.push(`${rel}: ${err}`);
      }),
    ),
  );
  for (const rel of HOME_CONTENT_WIPE_DIRS) {
    const dirFailures = await removeDirectoryContents(path.join(HOME_DIR, rel));
    failures.push(...dirFailures.map((f) => labelFailure(rel, f)));
  }
  for (const { rel, keep } of HOME_CONTENT_WIPE_KEEP) {
    const dirFailures = await removeDirectoryContents(path.join(HOME_DIR, rel), keep);
    failures.push(...dirFailures.map((f) => labelFailure(rel, f)));
  }
  failures.push(...(await removeLooseHomeFiles()));
  // Agent-scheduled cron jobs. `crontab -r` exits non-zero when there is no
  // crontab — that's the desired end state, not a failure; anything else
  // (missing binary, cron.deny) leaves a persistence vector and gets logged.
  await execFile("crontab", ["-r"], { timeout: 10_000 }).catch((err) => {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (!/no crontab/i.test(stderr)) {
      console.warn("[Reset] Failed to clear crontab:", err instanceof Error ? err.message : err);
    }
  });
  return failures;
}

/**
 * Reset the Linux user password back to the shipping default ("clawbox"), so
 * a factory-reset device matches its as-flashed state. Without this, the only
 * thing the reset clears is the `password_configured` flag — the SSH/sudo
 * password stays whatever the previous owner set, leaving the device's
 * sentinel "factory" state still owned by the prior user.
 *
 * Best-effort: if the chpasswd service fails (rare — same path the wizard's
 * credentials route uses), the reset still proceeds so the device isn't
 * stuck. The wizard's CredentialsStep on first boot will re-prompt and
 * overwrite the password, so a stale value is never load-bearing.
 *
 * Runs AFTER the data/ wipe so the input file lands in a freshly-recreated
 * directory the wizard then writes its own state into.
 */
async function resetSystemPasswordToDefault(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CHPASSWD_INPUT_PATH), { recursive: true });
    await fs.writeFile(
      CHPASSWD_INPUT_PATH,
      chpasswdRecord(getSystemUsername(), FACTORY_DEFAULT_PASSWORD),
      { mode: 0o600 },
    );
    await startRootStep(CHPASSWD_STEP, { timeoutMs: 30_000 });
    console.log("[Reset] System password reset to factory default");
  } catch (err) {
    // The input file carries a plaintext credential — scrub it on failure.
    await fs.unlink(CHPASSWD_INPUT_PATH).catch(() => {});
    // Error, not warn: a failed reset leaves the device in a security
    // regression (factory-reset but still owned with the prior password)
    // until the wizard's CredentialsStep runs on next boot and overwrites.
    console.error(
      "[Reset][SECURITY] System password NOT reset — prior password still active until CredentialsStep runs:",
      err instanceof Error ? err.message : err,
    );
  }
}

function scheduleReboot(): void {
  setTimeout(async () => {
    try {
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reboot"], { timeout: 10_000 });
    } catch (err) {
      console.error("[Reset] Reboot failed:", err instanceof Error ? err.message : err);
    }
  }, 1_000);
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  // Factory reset wipes data/, ~/.openclaw, ~/.hermes and reboots. It has no
  // onboarding role whatsoever, so it never gets the bootstrap carve-out: no
  // session, no reset, on any device state. This handler USED to be
  // `export async function POST()` — zero parameters, so it could not read a
  // cookie even in principle — and an unauthenticated POST really did wipe the
  // QA box on 2026-08-22T00:04Z. TASK-443.
  // The owner's account itself: never another ClawBox user's to change or
  // wipe, whatever else of the desktop they share (src/lib/non-owner-scope.ts).
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) {
    await padResponseTime(startedAt);
    return unauthorized;
  }

  // A session is what stops a stranger; it is not what stops the owner losing
  // the box to one misdirected click, and a stolen or shared browser carries a
  // live session too. So the request also has to re-prove the OS password and
  // carry the typed confirmation — the rest of TASK-443's ask.
  //
  // The password check makes this route a right/wrong oracle, so it runs on
  // exactly the same throttle and response-time pad as /login-api. The typed
  // token is checked FIRST and cheaply: a caller who cannot spell it never
  // reaches the oracle, and never burns a lockout attempt on the owner's
  // behalf.
  const buckets = lockoutBuckets(request);
  const locked = await checkReproveLockout(buckets, startedAt);
  if (locked) return locked;

  let body: { password?: string; confirm?: string };
  try {
    body = await request.json();
  } catch {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isFactoryResetConfirmed(body.confirm)) {
    await padResponseTime(startedAt);
    return NextResponse.json(
      { error: `Type ${FACTORY_RESET_CONFIRMATION} to confirm the factory reset` },
      { status: 400 },
    );
  }

  const refused = await reproveOwnerPassword(body.password ?? "", buckets, startedAt);
  if (refused) return refused;

  try {
    await maskAndStopGateway();

    // Only once the wipe is really starting: a reset that ended above must
    // leave a running update's state as it was.
    resetUpdateState();

    const dataFailures: string[] = [];
    // The top of data/ is wiped by a readdir + rm pass of its own rather than
    // through removeDirectoryContents (it keeps no retry, so a survivor is
    // reported on the first pass), so it needs the same guard: a link planted
    // at data/ would point this rm at whatever it names.
    const dataGuard = await guardDirectory(DATA_DIR);
    if (dataGuard.kind === "failure") dataFailures.push(dataGuard.failure);
    if (dataGuard.kind === "directory") {
      try {
        const entries = await fs.readdir(DATA_DIR);
        const results = await Promise.allSettled(
          entries
            .filter(entry => !DATA_KEEP_NAMES.has(entry))
            .map(entry => fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true }))
        );
        for (const r of results) {
          if (r.status === "rejected") dataFailures.push(String(r.reason));
        }
      } catch (err: unknown) {
        if (!isEnoent(err)) throw err;
      }
    }
    // …then take each container keep down to its exception list.
    for (const { rel, keep } of DATA_KEEP) {
      if (!keep) continue;
      dataFailures.push(
        ...(await removeDirectoryContents(path.join(DATA_DIR, rel), keep)).map((f) => labelFailure(rel, f)),
      );
    }

    const openclawFailures = await removeDirectoryContents(OPENCLAW_DIR);
    // ClawKeep state (token, config, passphrase, schedule) lives in its own
    // dir (~/.clawkeep), outside DATA_DIR and ~/.openclaw — so without this a
    // factory reset would leave the device still paired to the previous
    // account's cloud backups. Wipe it too.
    const clawkeepFailures = await removeDirectoryContents(CLAWKEEP_DATA_DIR);
    // Previous-owner home-dir state (SSH keys, browser profile, user files…).
    const homeFailures = await wipeHomeUserState();
    const allFailures = [...dataFailures, ...openclawFailures, ...clawkeepFailures, ...homeFailures];

    // 4. Seed minimal openclaw.json with token-based gateway auth so the
    // gateway can still bind on LAN after reboot. The token is a freshly
    // generated 32-byte random hex per reset — earlier builds wrote the
    // literal "clawbox", which is public via the open-source repo and let
    // any LAN client connect straight to the gateway WS. The wizard reads
    // this back on the next configure save (`getOrGenerateGatewayToken`)
    // and reuses it.
    try {
      await fs.mkdir(OPENCLAW_DIR, { recursive: true });
      const seed = {
        // No compaction block: OpenClaw 2 replaced the reserve-tuning keys
        // with compaction.mode and fails validation on the old one; its own
        // safeguard default needs no seeding.
        gateway: {
          auth: { mode: "token", token: crypto.randomBytes(32).toString("hex") },
          // No controlUi block: OpenClaw 2 retired allowInsecureAuth and
          // dangerouslyDisableDeviceAuth (a config carrying them fails
          // validation), and gateway-pre-start.sh writes allowedOrigins on
          // every boot. Browsers authenticate with the token plus a device
          // identity (src/lib/gateway-device-identity.ts).
        },
      };
      await fs.writeFile(
        path.join(OPENCLAW_DIR, "openclaw.json"),
        JSON.stringify(seed, null, 2),
        { mode: 0o600 },
      );
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await fs.chown(path.join(OPENCLAW_DIR, "openclaw.json"), uid, gid);
      console.log("[Reset] Seeded openclaw.json with token auth");
    } catch (err) {
      console.warn("[Reset] Failed to seed openclaw.json:", err instanceof Error ? err.message : err);
    }

    // 5. Delete all Ollama models
    await deleteOllamaModels().catch((err) => {
      console.error("[Reset] Ollama cleanup failed:", err instanceof Error ? err.message : err);
    });

    // Always unmask before either reboot or returning a failure — leaving the
    // unit masked would block the gateway from coming back on the next boot.
    await unmaskGateway();

    // Surface partial-wipe failures BEFORE any connectivity-destructive step.
    // Deleting the WiFi profile / resetting the login password without the
    // reboot that follows (the AP only returns on reboot, and the abort path
    // does NOT reboot) would strand a WiFi-only device offline with no way to
    // retry. Gate first so an incomplete wipe leaves the box reachable.
    if (allFailures.length > 0) {
      console.warn(`[Reset] Aborting reboot — ${allFailures.length} wipe failure(s)`);
      return NextResponse.json(
        { error: `Factory reset incomplete: ${allFailures.length} file deletion(s) failed`, failures: allFailures },
        { status: 500 },
      );
    }

    // 6. Delete saved WiFi connections so device returns to AP mode after reboot
    await deleteWifiConnections().catch((err) => {
      console.error("[Reset] WiFi cleanup failed:", err instanceof Error ? err.message : err);
    });

    // 6a. Reset the Linux user password to the shipping default.
    await resetSystemPasswordToDefault();

    // 6b. Reset mDNS hostname to "clawbox" (avahi + hostnamectl). Data dir is
    // already wiped, so clawbox-root-update@set_hostname.service will read the
    // default and apply it before the reboot.
    try {
      await startRootStep("set_hostname", { timeoutMs: 10_000 });
    } catch (err) {
      console.warn("[Reset] Failed to reset hostname:", err instanceof Error ? err.message : err);
    }

    scheduleReboot();

    const response = NextResponse.json({ success: true });
    response.cookies.set("clawbox_session", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      secure: false,
    });
    return response;
  } catch (err) {
    const unmasked = await unmaskGateway();
    let error = err instanceof Error ? err.message : "Factory reset failed";
    if (err instanceof GatewayNotStoppedError && err.stillStopping) {
      // Said only once systemd took the restart: a masked unit refuses it.
      error += unmasked && await startGatewayAgain()
        ? " The assistant was asked to start again; try the reset again in a few minutes."
        : " The assistant stays stopped until the device is restarted.";
    }
    return NextResponse.json(
      { error },
      { status: 500 },
    );
  }
}
