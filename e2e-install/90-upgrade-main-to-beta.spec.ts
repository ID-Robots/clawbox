/**
 * Upgrade test: the general suite first installs the checked-out PR head so
 * all preceding installer/UI assertions exercise the code under review. This
 * serial tail then uses that live updater to establish a real `main` baseline,
 * pins .update-branch to the target, and verifies main → target through the
 * post-reboot continuation step.
 *
 * This test relies on the shared container set up by `global-setup.ts` —
 * run it after happy-path.spec.ts.
 *
 * The HTTP endpoint goes down for MINUTES, not seconds, and by design. The
 * updater stops clawbox-setup.service for the whole rebuild
 * (`do_rebuild`) and starts it again at the end (`step_rebuild_reboot` →
 * `systemctl restart`, the test-mode stand-in for the reboot). Nothing brings
 * it back in between since TASK-728 removed `clawbox-gateway.service`'s
 * `Wants=clawbox-setup.service` — which is the point of that change, and which
 * used to be why `/setup-api/update/status` kept answering across a rebuild at
 * all (on the PRE-UPDATE build, which is the defect it fixes).
 *
 * So both `waitForUpdate` calls below pass an explicit downtime budget rather
 * than the helper's default of 60 consecutive failures (~183 s): `bun install`
 * plus `next build` on a qemu-x86 fallback runner is well past that, and the
 * default would report `update status unreachable` over an update that
 * completed. 420 × 3 s = 21 min, sized on the updater's own
 * REBUILD_TAKEOVER_TIMEOUT_MS (20 min) and still inside the 45-minute ceiling.
 *
 * The `beta` branch must exist on origin with a commit ancestor-mergeable
 * from main (or at least a git-resettable ref). This matches how the real
 * updater works: `git fetch origin && git reset --hard origin/beta`.
 */
import { test, expect } from "@playwright/test";
import {
  BASE_URL,
  dockerExec,
  readGitBranch,
  setUpdateBranch,
} from "./helpers/container";
import { startUpdate, waitForUpdate } from "./helpers/setup-api";
import { READY_ACTION_TIMEOUT, waitForAppReady, waitForGatewayReady } from "./helpers/readiness";
import {
  KEY_LINE,
  baseVersion,
  describePass,
  describeRefresh,
  journalAfter,
  journalCursor,
  openclawCli,
  parseJsonOut,
  readMigrationRow,
  retiredKeyPathMissed,
  summarizeDoctor,
  type DoctorSummary,
  type MigrationRowRead,
} from "./helpers/openclaw-plugin-migration";

test.use(READY_ACTION_TIMEOUT);

const UPGRADE_BRANCH = process.env.CLAWBOX_UPGRADE_TARGET_BRANCH ?? "beta";

/**
 * The core crossing. A box whose owner signed in with a ChatGPT subscription
 * runs the Codex runtime: `agents.defaults.models["openai/<id>"].agentRuntime.id
 * = "codex"` (src/lib/chatgpt-subscription.ts) and the external @openclaw/codex
 * plugin at its core's version. The pinned core binds codex's version to its
 * own (dist official-runtime-plugins: VERSION_BOUND_RUNTIME_PLUGIN_IDS), so
 * after a core bump that plugin is stale when doctor runs — ClawBox refreshes
 * plugins only after doctor — and doctor owes it a data/settings migration
 * (codex declares doctorContract.stateMigrations). That is the state an update
 * once stopped on at "Updating OpenClaw", and the emptied home the baseline
 * builds never has it. So the fixture gives main's core exactly that box, and
 * the last test proves from the core's own record that the obligation was
 * owed during this update AND completed: it cannot pass with nothing owed.
 *
 * And a config key the new core retired. On that box `openclaw.json` also held
 * a per-agent heartbeat (`agents.entries.<id>.heartbeat`), valid on the old core
 * and unknown to 2026.11.5. With an invalid config, doctor plans an automatic
 * repair from a snapshot taken BEFORE it rewrites codex's obligation, and
 * commits it AFTER, carrying the old obligation list: the core's publication
 * check then throws "Plugin migration obligations changed during migration
 * input publication" and the pass ends incomplete (dist doctor-config-flow:
 * planAdmittedConfigRepair, then the obligation rewrite, then
 * commitAutomaticConfigRepair). A config the new core accepts never takes
 * that path.
 */
const CODEX_ARM_MODEL = "openai/gpt-5.5";
const CODEX_ARM_PATH = `agents.defaults.models[${JSON.stringify(CODEX_ARM_MODEL)}].agentRuntime.id`;
/** Where a ChatGPT sign-in is filed (CHATGPT_PROFILE_KEY in src/lib/chatgpt-subscription.ts). */
const CHATGPT_PROFILE_PATH = "auth.profiles.openai:chatgpt";
/** Valid at 2026.10.9 and retired at 2026.11.5; "0m" turns off only the recurring cadence. */
const RETIRED_KEY_PATH = "agents.entries.main.heartbeat";
const RETIRED_KEY_VALUE = JSON.stringify({ every: "0m" });
const OPENCLAW_JSON = "/home/clawbox/.openclaw/openclaw.json";
/** The root step that installs the core and runs doctor; its journal is its own output. */
const OPENCLAW_INSTALL_UNIT = "clawbox-root-update@openclaw_install.service";

/** Main's pin and the target's; set by the fixture. Equal pins cross nothing. */
let mainPin = "";
let targetPin = "";
let crossing = false;
/** Main's core took the retired key, so the update must cross the path it opens. */
let retiredKeySet = false;
/** Where the target update's openclaw_install journal starts, and when it was triggered (epoch ms, container clock). */
let updateCursor: string | null = null;
let triggeredAtMs = 0;
let updateSeconds: number | null = null;
let codexRowBefore: MigrationRowRead | null = null;

/** The first word of a pin file, as the updater reads it (readPinsAtBranch). */
const firstWord = (text: string) => text.trim().split(/\s+/)[0] ?? "";

/**
 * The target branch's OpenClaw pin, read from the branch itself. Not the host
 * checkout: the schedule and a push to main check out main and target beta.
 * Not a fetch into the box's checkout either, which would change what the
 * updater then finds there: a blob-less shallow clone in a scratch directory,
 * from the remote the updater fetches.
 */
async function readTargetPin(branch: string): Promise<string> {
  if (!/^[A-Za-z0-9._\-/]+$/.test(branch)) throw new Error(`unsafe branch name: ${branch}`);
  const out = await dockerExec([
    "bash", "-c",
    [
      "set -euo pipefail",
      'dir="$(mktemp -d)"',
      "trap 'rm -rf \"$dir\"' EXIT",
      'url="$(git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox remote get-url origin)"',
      'git clone --quiet --filter=blob:none --depth=1 --no-checkout --single-branch --branch "$1" "$url" "$dir/pin"',
      'git -C "$dir/pin" show HEAD:config/openclaw-target.txt',
    ].join("; "),
    "bash", branch,
  ], { user: "clawbox", timeoutMs: 120_000 });
  return firstWord(out);
}

async function coreVersion(): Promise<string> {
  const out = await openclawCli(["--version"], 120_000);
  return out.stdout.split(/\s+/).find((field) => /^\d+\.\d+\.\d+/.test(field)) ?? "";
}

interface PluginRow {
  id?: unknown;
  origin?: unknown;
  enabled?: unknown;
  status?: unknown;
  version?: unknown;
  rootDir?: unknown;
}

/** codex's row in `openclaw plugins list --json`, with the version of the package it loads. */
async function codexPlugin(): Promise<{ row: PluginRow | undefined; version: string }> {
  const listed = await openclawCli(["plugins", "list", "--json"], 120_000);
  expect(listed.exit, `openclaw plugins list --json: ${listed.stderr}`).toBe(0);
  const plugins = (parseJsonOut(listed.stdout) as { plugins?: PluginRow[] }).plugins ?? [];
  const row = plugins.find((plugin) => plugin.id === "codex");
  let version = typeof row?.version === "string" ? row.version : "";
  if (!version && typeof row?.rootDir === "string") {
    const pkg = await dockerExec(["cat", `${row.rootDir}/package.json`], { user: "clawbox" });
    version = String((JSON.parse(pkg) as { version?: unknown }).version ?? "");
  }
  return { row, version };
}

interface OpenclawJson {
  agents?: {
    defaults?: { models?: Record<string, { agentRuntime?: { id?: unknown } }> };
    entries?: Record<string, { heartbeat?: unknown }>;
  };
  plugins?: { allow?: unknown };
}

const readOpenclawJson = async () =>
  JSON.parse(await dockerExec(["cat", OPENCLAW_JSON], { user: "clawbox" })) as OpenclawJson;

/**
 * Does main's core (its own `config schema --json`) know this string key? `*`
 * is a map entry. `agents.defaults.models.*.agentRuntime.id` is the codex arm;
 * `agents.entries.*.heartbeat.every` the retired key.
 */
function schemaHasString(schema: unknown, path: string): boolean {
  let node: unknown = schema;
  for (const key of path.split(".")) {
    const steps = key === "*" ? ["additionalProperties"] : ["properties", key];
    for (const step of steps) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[step] : undefined;
    }
  }
  const type = node && typeof node === "object" ? (node as Record<string, unknown>).type : undefined;
  return type === "string";
}

const describeRow = (read: MigrationRowRead | null) =>
  !read ? "(not read)"
    : !read.db ? "(no state database)"
      : !read.table ? "(no migration_runs table)"
        : read.row ? JSON.stringify(read.row) : "(no row)";

/**
 * What the target update did to codex, printed to the job log (the workflow
 * dumps the container's journal only on failure, and annotations live only in
 * the HTML report): the bounded openclaw_install journal, its doctor passes,
 * the conflict line, the unit's own result and the core's record for codex.
 */
async function reportCrossing(
  outcome: string,
): Promise<{ doctor: DoctorSummary | null; refresh: string | null; row: MigrationRowRead }> {
  const log = (line: string) => console.log(`[codex crossing] ${line}`);
  log(`core ${mainPin} -> ${targetPin}; update ${outcome}`);
  let doctor: DoctorSummary | null = null;
  let refresh: string | null = null;
  if (updateCursor) {
    const lines = await journalAfter(OPENCLAW_INSTALL_UNIT, updateCursor);
    doctor = summarizeDoctor(lines);
    log(
      `${OPENCLAW_INSTALL_UNIT} since the trigger: ${doctor.entries} entries over ${doctor.spanSeconds ?? "?"} s; ` +
      `doctor passes ${doctor.passes.length}`,
    );
    doctor.passes.forEach((pass, index) => {
      log(describePass(pass, index));
      if (pass.conflictLine) log(`pass ${index + 1} conflict line: ${pass.conflictLine}`);
    });
    if (retiredKeySet) log(`retired-key path in pass 1: ${retiredKeyPathMissed(doctor.passes[0]) ?? "exercised"}`);
    // What the plugin refresh after doctor did with the real @openclaw/codex.
    refresh = describeRefresh(lines);
    log(`plugin refresh after doctor: ${refresh}`);
    // Every doctor phase and the lines the checks read; the full journal is the attachment.
    const tempWarnings = lines.filter((line) => line.message.includes("Temp workspace ancestor")).length;
    for (const line of lines) {
      if (KEY_LINE.test(line.message) && !line.message.includes("Temp workspace ancestor")) log(`doctor| ${line.message}`);
    }
    if (tempWarnings > 0) log(`(${tempWarnings} "Temp workspace ancestor" lines left out: a fallback, not a failure)`);
    if (outcome !== "completed") {
      for (const line of lines.slice(-60)) log(`tail| ${line.message}`);
    }
    await test.info().attach("openclaw_install journal since the trigger", {
      body: lines.map((line) => line.message).join("\n"),
      contentType: "text/plain",
    });
  } else {
    log("no journal cursor was taken at the trigger");
  }
  const unit = await dockerExec(
    ["systemctl", "show", OPENCLAW_INSTALL_UNIT, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"],
    { user: "root" },
  );
  log(`unit ${unit.trim().split("\n").join(", ")}`);
  const row = await readMigrationRow("codex");
  log(`migration_runs deferred-plugin-migration:codex before the update: ${describeRow(codexRowBefore)}`);
  log(`migration_runs deferred-plugin-migration:codex now: ${describeRow(row)}`);
  return { doctor, refresh, row };
}

/**
 * How many consecutive unanswered status polls (3 s apart) are a rebuild rather
 * than a broken box — see the header. 21 minutes, sized on the updater's own
 * REBUILD_TAKEOVER_TIMEOUT_MS.
 */
const REBUILD_DOWNTIME_POLLS = 420;

/**
 * How long no OpenClaw process may have run before the main baseline archives
 * the PR head's OpenClaw home. The catalogue warm-up (bootWarmup in
 * src/app/setup-api/ai-models/catalog/route.ts) starts its CLI calls at 5, 10,
 * 20 and 30 s; the widest gap is 10 s. So a longer quiet window means the
 * warm-up is over, not paused between two forks. The second constant bounds
 * the whole wait: what is left of the warm-up plus one quiet window.
 */
const OPENCLAW_QUIET_MS = 15_000;
const OPENCLAW_QUIET_TIMEOUT_MS = 2 * 60_000;

/** `pid args` of every OpenClaw process in the container: the CLI, the gateway, a script run on its store. */
async function openclawProcesses(): Promise<string[]> {
  const out = await dockerExec(["ps", "-eo", "pid=,args="], { user: "root" });
  return out
    .split("\n")
    .map((line) => line.trim())
    // `openclaw` as a command word or a path segment. `.openclaw` is a path
    // into its home, which is not OpenClaw running.
    .filter((line) => /(^|[\s/])openclaw([\s/.:_-]|$)/.test(line.replace(/^\d+\s+/, "")));
}

/**
 * Stop every OpenClaw process of the PR head, and return once none has started
 * for OPENCLAW_QUIET_MS.
 *
 * Killed, not waited out: `openclaw` is a launcher that re-spawns the real CLI
 * as a detached grandchild, and that one can stay up for minutes after its
 * answer (route.ts, fetchOpenclawCatalogOnce). Killing them is safe here. The
 * gateway is already stopped, and the home they hold is archived and never
 * read again. A catalogue fork killed before it answers counts as a failed
 * refresh, which backs off rather than forking again.
 */
async function quiesceOpenclaw(): Promise<void> {
  const deadline = Date.now() + OPENCLAW_QUIET_TIMEOUT_MS;
  let quietSince: number | null = null;
  let running: string[] = [];
  while (Date.now() < deadline) {
    running = await openclawProcesses();
    if (running.length > 0) {
      quietSince = null;
      const pids = running.map((line) => line.split(/\s+/)[0]).join(" ");
      // One may have exited since `ps` listed it.
      await dockerExec(["bash", "-c", `kill -KILL ${pids} 2>/dev/null || true`], { user: "root" });
    } else if (quietSince === null) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= OPENCLAW_QUIET_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `OpenClaw kept starting for ${OPENCLAW_QUIET_TIMEOUT_MS / 1000}s after the gateway stopped, ` +
      `so the main baseline cannot archive its home: ${running.join(" | ") || "(none at the last look)"}`,
  );
}

test.describe.configure({ mode: "serial" });

test.describe(`in-app upgrade: main → ${UPGRADE_BRANCH}`, () => {
  test("establish a real main baseline through the in-app updater", async () => {
    // Do not make the whole suite install stale main just to create this one
    // precondition: security/UI tests before this file must run against the PR
    // head. Transition this already-configured device to main through the same
    // update path a field device uses, preserving its setup state.
    // This suite initially installs the PR head (OpenClaw 2 / schema 2026.8)
    // so every general assertion exercises the code under review. `main`
    // currently pins OpenClaw 2026.7, whose binary deliberately refuses to
    // touch config last written by 2026.8. A field device should never be
    // downgraded this way; this is only the ephemeral harness constructing a
    // clean historical baseline. Archive the future OpenClaw home while
    // leaving ClawBox's data/config.json (the setup state this test promises to
    // preserve) untouched, then let main create the store shape it understands.
    await dockerExec(["bash", "-lc", "systemctl stop clawbox-gateway.service || true"], { user: "root" });
    // The archive only holds if no OpenClaw of the PR head runs after it: any
    // CLI call writes a fresh state database on its own (newer) schema into the
    // empty home, and main's updater then refuses to install over it before
    // step 1. The wizard that just ran leaves such calls behind. Its AI step
    // opens the model catalogue, whose warm-up runs `openclaw models list` for
    // each provider it enumerates through the CLI, 5 s apart, for about 30 s.
    await quiesceOpenclaw();
    await dockerExec([
      "bash", "-lc",
      "set -e; " +
      "test ! -e /home/clawbox/.openclaw-e2e-future; " +
      "if [ -e /home/clawbox/.openclaw ]; then mv /home/clawbox/.openclaw /home/clawbox/.openclaw-e2e-future; fi; " +
      "install -d -o clawbox -g clawbox -m 700 /home/clawbox/.openclaw",
    ], { user: "root" });

    await setUpdateBranch("main");
    const result = await startUpdate(true);
    expect(result.started).toBe(true);

    const state = await waitForUpdate({ timeoutMs: 45 * 60_000, maxConsecutiveFetchErrors: REBUILD_DOWNTIME_POLLS });
    expect(["completed", "failed"]).toContain(state.phase);
    if (state.phase === "failed") {
      const failedStep = state.steps.find((step) => step.status === "failed");
      throw new Error(
        `main baseline failed at step '${failedStep?.id}': ${failedStep?.error ?? state.error ?? "unknown"}`,
      );
    }
    for (const step of state.steps) {
      expect(step.status).toBe("completed");
    }
    await waitForAppReady({ timeoutMs: 5 * 60_000, context: "main baseline" });
  });

  test("verify current branch is main", async () => {
    const branch = await readGitBranch();
    expect(branch, "the upgrade must exercise main → target, not target → itself").toBe("main");
  });

  test("a ChatGPT-style box with a heartbeat the new core retires", async () => {
    mainPin = firstWord(await dockerExec(["cat", "/home/clawbox/clawbox/config/openclaw-target.txt"]));
    targetPin = await readTargetPin(UPGRADE_BRANCH);
    expect(mainPin, "fixture: main's checkout has no OpenClaw pin").not.toBe("");
    expect(targetPin, `fixture: ${UPGRADE_BRANCH} has no OpenClaw pin`).not.toBe("");
    crossing = mainPin !== targetPin;
    test.info().annotations.push({
      type: "codex-obligation",
      description: crossing ? `core ${mainPin} -> ${targetPin}` : `not exercised (no core crossing: both pin ${mainPin})`,
    });
    console.log(`[codex crossing] main pins ${mainPin}, ${UPGRADE_BRANCH} pins ${targetPin}: ${crossing ? "crossing" : "not exercised"}`);
    // Equal pins owe nothing, so there is nothing to prove and no reason to
    // fetch codex twice: "not exercised", never a pass and never a failure.
    if (!crossing) return;

    // The baseline ends when the web server answers; the CLI below wants the
    // core and its gateway settled first.
    await waitForGatewayReady({ timeoutMs: 10 * 60_000, context: "the codex fixture" });
    expect(await coreVersion(), "fixture: main's core does not answer main's pin").toBe(mainPin);
    const schema = await openclawCli(["config", "schema", "--json"], 300_000);
    expect(schema.exit, `fixture: openclaw config schema --json: ${schema.stderr}`).toBe(0);
    const schemaJson = parseJsonOut(schema.stdout);
    expect(
      schemaHasString(schemaJson, "agents.defaults.models.*.agentRuntime.id"),
      "fixture: main's core has no agents.defaults.models.*.agentRuntime.id",
    ).toBe(true);
    // Only while main's core still knows the key: once main carries a core that
    // retired it, its CLI refuses the write and that path has nothing to cross.
    // Then it is "not exercised", never a failure; every codex check still runs.
    retiredKeySet = schemaHasString(schemaJson, "agents.entries.*.heartbeat.every");
    if (!retiredKeySet) {
      test.info().annotations.push({
        type: "retired-key path",
        description: "not exercised (main's core has no agents.entries.*.heartbeat)",
      });
    }

    // The plugin first, at main's pin, the way the installer's refresh pins it
    // (`plugins install @openclaw/codex@<pin> --force --accept-capabilities`):
    // with the arm already set, a gateway start in between would race to
    // install it under main's pre-start, whose attempt is time-boxed to 120 s.
    // Then the arm, then the restart, whose pre-start finds codex at its core's
    // version and leaves it be. The plugin pulls a large app-server package.
    const installStarted = Date.now();
    const install = await openclawCli(
      ["plugins", "install", `@openclaw/codex@${mainPin}`, "--force", "--accept-capabilities"],
      15 * 60_000,
    );
    expect(install.exit, `fixture: plugins install @openclaw/codex@${mainPin}: ${install.stdout}${install.stderr}`).toBe(0);
    const installSeconds = Math.round((Date.now() - installStarted) / 1000);
    // The sign-in's profile entry, without a credential (as 22-anthropic-accounts
    // stages one): on an OpenAI API-key box with no ChatGPT sign-in, main's and
    // the target's pre-start remove the codex arm, and the wizard's OpenAI key
    // may have left such a profile.
    const profile = await openclawCli(
      ["config", "set", CHATGPT_PROFILE_PATH, JSON.stringify({ provider: "openai", mode: "oauth" }), "--strict-json"],
      120_000,
    );
    expect(profile.exit, `fixture: config set ${CHATGPT_PROFILE_PATH}: ${profile.stdout}${profile.stderr}`).toBe(0);
    const arm = await openclawCli(["config", "set", CODEX_ARM_PATH, "codex"], 120_000);
    expect(arm.exit, `fixture: config set ${CODEX_ARM_PATH}: ${arm.stdout}${arm.stderr}`).toBe(0);
    if (retiredKeySet) {
      // Through the old core's own CLI, which checks it against its schema.
      const heartbeat = await openclawCli(["config", "set", RETIRED_KEY_PATH, RETIRED_KEY_VALUE, "--strict-json"], 120_000);
      expect(heartbeat.exit, `fixture: main's core refused ${RETIRED_KEY_PATH}: ${heartbeat.stdout}${heartbeat.stderr}`)
        .toBe(0);
    }
    const restartStarted = Date.now();
    await dockerExec(["systemctl", "restart", "clawbox-gateway.service"], { user: "root", timeoutMs: 10 * 60_000 });
    await waitForGatewayReady({ timeoutMs: 10 * 60_000, context: "the codex fixture's gateway restart" });
    const restartSeconds = Math.round((Date.now() - restartStarted) / 1000);

    // Hard preconditions: without every one of them the update below owes
    // codex nothing and would pass for the wrong reason.
    const codex = await codexPlugin();
    expect(codex.row, "fixture: codex is not in `openclaw plugins list --json`").toBeDefined();
    expect(codex.row?.origin, "fixture: codex is the bundled copy, not the external plugin").not.toBe("bundled");
    expect(codex.row?.enabled, `fixture: codex is not enabled (status ${String(codex.row?.status)})`).toBe(true);
    expect(baseVersion(codex.version), "fixture: codex is not at main's pin").toBe(baseVersion(mainPin));
    const config = await readOpenclawJson();
    expect(
      config.agents?.defaults?.models?.[CODEX_ARM_MODEL]?.agentRuntime?.id,
      "fixture: the codex runtime arm did not survive the gateway restart",
    ).toBe("codex");
    const allow = config.plugins?.allow;
    expect(
      allow === undefined || (Array.isArray(allow) && allow.includes("codex")),
      `fixture: plugins.allow ${JSON.stringify(allow)} keeps codex out`,
    ).toBe(true);
    if (retiredKeySet) {
      expect(
        config.agents?.entries?.main?.heartbeat,
        "fixture: the per-agent heartbeat did not survive the gateway restart",
      ).toBeDefined();
    }

    codexRowBefore = await readMigrationRow("codex");
    test.info().annotations.push({
      type: "codex-fixture-seconds",
      description: `plugins install ${installSeconds} s, gateway restart ${restartSeconds} s`,
    });
    console.log(
      `[codex crossing] fixture: codex ${codex.version} at main's core ${mainPin}; install ${installSeconds} s, ` +
      `restart ${restartSeconds} s; migration row before the update: ${describeRow(codexRowBefore)}`,
    );
  });

  test(`pin .update-branch to ${UPGRADE_BRANCH}`, async () => {
    await setUpdateBranch(UPGRADE_BRANCH);
    const contents = await dockerExec(["cat", "/home/clawbox/clawbox/.update-branch"], {
      user: "clawbox",
    });
    expect(contents.trim()).toBe(UPGRADE_BRANCH);
  });

  test("trigger updater", async () => {
    // The baseline's own update ran openclaw_install in the same unit, so only
    // what comes after this point is the target update's.
    triggeredAtMs = Number((await dockerExec(["date", "+%s%3N"])).trim());
    updateCursor = await journalCursor();
    if (crossing) expect(updateCursor, "fixture: no journal cursor to bound openclaw_install's journal by").not.toBeNull();
    const result = await startUpdate(true);
    expect(result.started).toBe(true);
  });

  test("update completes through restart and post_update", async () => {
    // The updater restarts clawbox-setup.service mid-run (the replacement
    // for `reboot` in test mode). `waitForUpdate` retries across that
    // downtime; it also needs to see the `post_update` step run via
    // `checkContinuation`, which the server's own boot hook fires a few
    // seconds after it is back up (our status polls are only the fallback).
    const state = await waitForUpdate({ timeoutMs: 45 * 60_000, maxConsecutiveFetchErrors: REBUILD_DOWNTIME_POLLS });
    // `waitForUpdate` returns only a terminal phase — "completed" once
    // post_update and the checks after it ran, or "failed" — polling through
    // the restart and the resumed second half to get there.
    expect(["completed", "failed"]).toContain(state.phase);
    if (state.phase === "failed") {
      const failedStep = state.steps.find((s) => s.status === "failed");
      if (crossing) {
        // Before the throw: the cases after this one are skipped (serial). A
        // collection error must not replace the step id below.
        try {
          await reportCrossing(`failed at step '${failedStep?.id}'`);
        } catch (err) {
          console.log(`[codex crossing] evidence could not be collected: ${String(err)}`);
        }
      }
      throw new Error(`update failed at step '${failedStep?.id}': ${failedStep?.error ?? state.error ?? "unknown"}`);
    }
    // Every step should be completed by the end.
    for (const step of state.steps) {
      expect(step.status).toBe("completed");
    }
    if (crossing) updateSeconds = Math.round((Date.now() - triggeredAtMs) / 1000);
  });

  test(`git HEAD is on ${UPGRADE_BRANCH}`, async () => {
    // The box is back AND its gateway answers: the upgrade is only done when
    // the assistant is reachable again, not when the web server is.
    await waitForGatewayReady({ timeoutMs: 5 * 60_000, context: "post-upgrade checks" });
    const branch = await readGitBranch();
    expect(branch).toBe(UPGRADE_BRANCH);
  });

  test("the update leaves a root-owned mirror, and root runs out of it", async () => {
    // TASK-733. This is the one test that exercises the ROLLOUT rather than the
    // mechanism: the container has just come across the transition described in
    // docs/root-exec-mirror.md — an old build, whose dispatcher runs the tree,
    // updating to a build whose dispatcher will not. If the mirror were staged
    // after the new dispatcher rather than before it, every root step here would
    // already be failing; if it lived on /run it would be gone, because
    // rebuild_reboot restarts the box between the two halves of the update.
    const mirror = (await dockerExec(
      ["/usr/local/libexec/clawbox/clawbox-root-manifest.sh", "--mirror-path"],
      { user: "root" },
    )).trim();
    expect(mirror).toBe("/var/lib/clawbox/root-exec-mirror");

    const listing = await dockerExec([
      "bash", "-lc",
      `stat -c '%U %G %a' ${mirror} && ls ${mirror} | sort | tr '\\n' ' '`,
    ], { user: "root" });
    const [ownership, contents] = listing.trim().split("\n");
    expect(ownership, "the mirror must be root-owned or it is decorative").toBe("root root 755");
    expect(contents.trim()).toBe("config install.sh scripts");

    // The account the web server runs as must not be able to write it — that IS
    // the property, and it is worth asserting rather than inferring from a mode.
    const writable = await dockerExec([
      "bash", "-lc",
      `if echo x > ${mirror}/install.sh 2>/dev/null; then echo WRITABLE; else echo refused; fi`,
    ], { user: "clawbox" });
    expect(writable.trim()).toBe("refused");

    // ...and the record still describes the tree, which is what lets the next
    // dispatch restage the mirror at all.
    const verified = await dockerExec([
      "bash", "-lc",
      "/usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify && echo recorded",
    ], { user: "root" });
    expect(verified.trim()).toBe("recorded");

    // Nothing root ran during the update came out of the clawbox-writable tree.
    // post_update is an EXEMPT step and the last one this update dispatched, so
    // its own journal is the honest place to look.
    const journal = await dockerExec([
      "bash", "-lc",
      "journalctl -u 'clawbox-root-update@post_update.service' --no-pager -o cat | tail -n 400 || true",
    ], { user: "root" });
    // Anchored so an EMPTY journal cannot pass it. The assertion below is an
    // absence, and `|| true` above means a renamed unit, a rotated journal or a
    // container without a persistent one yields "" — which satisfies any
    // absence check and proves nothing. That is the false-success class this PR
    // is about, in the test that guards it.
    //
    // The positive form is deliberately NOT asserted here: measured on a real
    // box, the clawbox-root-update@ units log no exec path at all, mirror or
    // tree, so requiring the mirror path would fail for the wrong reason. What
    // proves root ran the mirror is the case below, which drives the real
    // `sudo clawbox-run-root-step.sh` grant and watches the copy follow.
    expect(journal.trim(), "no journal for post_update — the absence check below would pass vacuously").not.toBe("");
    expect(journal).not.toMatch(/Starting.*\/home\/clawbox\/clawbox\/install\.sh/);
  });

  test("the mirror follows the tree on every dispatch, not once at install time", async () => {
    // Probe-once is one of the three defects this codebase keeps producing, and
    // a mirror staged at install time and trusted for ever would be exactly
    // that: the box would keep running the build before the update. So: change
    // a covered file, re-record it as root the way an update does, then take the
    // REAL granted path from the account the web server runs as — `sudo
    // clawbox-run-root-step.sh` — and see whether the copy root holds followed.
    //
    // `fix_git_perms` is the cheap step for this (one chown) and is on
    // WEB_ROOT_STEPS, so it goes through the same sudoers grant, launcher and
    // dispatcher an in-app update uses.
    const covered = "/home/clawbox/clawbox/config/clawbox-resource-limits.env";
    const mirrored = "/var/lib/clawbox/root-exec-mirror/config/clawbox-resource-limits.env";
    const marker = "# e2e-733-mirror-follows-the-tree";

    const before = await dockerExec([
      "bash", "-lc", `grep -c '${marker}' ${mirrored} || true`,
    ], { user: "root" });
    expect(before.trim(), "the marker must not be there before the test writes it").toBe("0");

    // The backup is taken on its own, BEFORE anything is mutated: a failure
    // here leaves the checkout untouched and there is nothing to restore. Every
    // mutation is inside the try, so a throw from the record write — which
    // happens after the file has already changed — still runs the finally. This
    // suite is `mode: "serial"`, so a checkout left modified poisons the cases
    // after it rather than failing this one.
    await dockerExec([
      "bash", "-lc", `cp ${covered} /tmp/e2e-733-covered.bak`,
    ], { user: "root" });

    try {
      await dockerExec([
        "bash", "-lc",
        `printf '\\n${marker}\\n' >> ${covered}`
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --write",
      ], { user: "root" });

      const dispatched = await dockerExec([
        "bash", "-lc",
        "sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh fix_git_perms 2>&1"
        + " && echo DISPATCHED",
      ], { user: "clawbox" });
      expect(dispatched, dispatched).toContain("DISPATCHED");

      const after = await dockerExec([
        "bash", "-lc", `grep -c '${marker}' ${mirrored} || true`,
      ], { user: "root" });
      expect(after.trim(), "the mirror still holds the previous build's copy").toBe("1");
    } finally {
      await dockerExec([
        "bash", "-lc",
        `cp /tmp/e2e-733-covered.bak ${covered} && rm -f /tmp/e2e-733-covered.bak`
        + " && chown clawbox:clawbox " + covered
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --write"
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --mirror",
      ], { user: "root" });
    }
  });

  test("setup state preserved across upgrade", async () => {
    // The upgrade must not wipe prior setup flags (wifi/password/ai).
    const res = await fetch(`${BASE_URL}/setup-api/setup/status`);
    const statusJson = await res.json();
    expect(statusJson.setup_complete).toBe(true);
    expect(statusJson.wifi_configured).toBe(true);
    expect(statusJson.password_configured).toBe(true);
  });

  // Last, so that a failure here leaves the checks above with their own verdicts.
  test("codex obligation and a retired config key crossed in one update", async () => {
    test.skip(!crossing, "codex-obligation: not exercised (no core crossing)");
    // Printed first, so a failing assertion below still leaves the evidence.
    const { doctor, refresh, row } = await reportCrossing("completed");
    // Recorded, never asserted: a later core that publishes the current
    // obligation list completes in one pass, and that is still a pass.
    test.info().annotations.push(
      {
        type: "doctor-passes",
        description: doctor
          ? `${doctor.passes.length}: ${doctor.passes.map((pass, index) => describePass(pass, index)).join(" | ")}`
          : "unknown",
      },
      {
        type: "update-seconds",
        description: `whole update ${updateSeconds ?? "?"} s, openclaw_install ${doctor?.spanSeconds ?? "?"} s`,
      },
      // The refresh's own row for codex after doctor, recorded like the passes:
      // the first word from a real package on what the skip rule does.
      { type: "plugin-refresh", description: refresh ?? "unknown" },
    );
    expect(doctor?.entries ?? 0, "no openclaw_install journal after the trigger: the core crossing never ran").toBeGreaterThan(0);
    // The trigger: the first pass met the retired key and took the repair that
    // follows codex's obligation rewrite. Without it this case proves only the
    // convergence a valid config already had.
    if (retiredKeySet) {
      expect(retiredKeyPathMissed(doctor?.passes[0]), "the retired-key path in the first doctor pass").toBeNull();
      expect(
        (await readOpenclawJson()).agents?.entries?.main?.heartbeat,
        "the retired heartbeat key is still in openclaw.json after the update",
      ).toBeUndefined();
    }

    // The box is on the target's core, and the pin it carries is the one the
    // fixture compared against.
    const onBox = firstWord(await dockerExec(["cat", "/home/clawbox/clawbox/config/openclaw-target.txt"]));
    expect(onBox, `fixture: the pin read from ${UPGRADE_BRANCH} is not the one the update installed`).toBe(targetPin);
    expect(await coreVersion()).toBe(targetPin);
    const codex = await codexPlugin();
    expect(codex.row, "codex is gone from `openclaw plugins list --json` after the update").toBeDefined();
    expect(baseVersion(codex.version), "codex did not follow the core").toBe(baseVersion(targetPin));
    const status = JSON.parse(await dockerExec(
      ["cat", "/home/clawbox/clawbox/data/openclaw-migration-status.json"],
      { user: "root" },
    )) as { doctor?: { core?: unknown; verdict?: unknown } };
    expect(status.doctor?.core, "the doctor verdict names another core").toBe(targetPin);
    expect(status.doctor?.verdict).toBe("complete");

    // The witness. No row means no obligation was ever recorded: the update
    // exercised nothing, whatever it reported.
    const record = row.row;
    expect(record, `fixture: no codex obligation was ever recorded, so the upgrade exercised nothing (${describeRow(row)})`)
      .toBeTruthy();
    if (!record) return;
    expect(
      record.finishedAt ?? record.startedAt,
      `fixture: the codex record predates this update (${JSON.stringify(record)})`,
    ).toBeGreaterThanOrEqual(triggeredAtMs);
    // "deferred" is the settle path ("Deferred until active"), which moves no
    // data; "pending" is an obligation the update left unfinished.
    const why: Record<string, string> = {
      deferred: "settled without migrating",
      pending: "left unfinished by the update",
    };
    expect(
      record.status,
      `codex's obligation was ${why[record.status] ?? record.status}: ${record.report}`,
    ).toBe("completed");
  });
});
