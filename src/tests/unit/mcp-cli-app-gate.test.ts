import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";
import { builtInApps, openedAppNotice } from "../../../mcp/lib/context";

/**
 * `clawbox app open` / `app list` on the DUAL SKU.
 *
 * The CLI is the agent's fallback when MCP tool calling is not available, and
 * it applies the same gate `ui_open_app` does — so it has to answer the same
 * question the same way. `installEdition()` returns THREE values (`openclaw`,
 * `hermes`, `dual`: the premium SKU carries both harnesses), and a two-way
 * branch on it folds `dual` into `openclaw`, which hides `hermes` and
 * `hermes-skills` from a box whose ACTIVE harness is Hermes. The desktop opens
 * that dashboard happily (`src/app/page.tsx` builds its grid from the active
 * harness) and so does the MCP tool (`mcp/lib/edition.ts` resolves `dual`
 * through `/setup-api/harness/active`) — the CLI was the one surface that
 * refused it, which is TASK-541's own symptom one surface over.
 *
 * The whole CLI had no test before this one; these run it as the agent does,
 * against a stub device.
 */

// Starts real processes (bun running the CLI, and the `have()` probe): vitest's
// 5 s test and 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const CLI = path.join(REPO, "mcp", "clawbox-cli.ts");

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

// The CLI's shebang is bun, and the device runs it with bun; there is no other
// runtime here that takes the TypeScript source unbuilt.
const CAN_RUN = process.platform !== "win32" && have("bun", ["--version"]);
const d = CAN_RUN ? describe : describe.skip;

// A skipped file reports green while asserting nothing, and this is the ONLY
// test of the CLI's gate. CI installs bun (pr-tests-coverage.yml,
// oven-sh/setup-bun), so if it ever stops resolving there, say so out loud
// rather than going quiet.
describe("the CLI can be run at all", () => {
  it.skipIf(!process.env.CI)("has bun on PATH in CI", () => {
    expect(CAN_RUN).toBe(true);
  });
});

let server: http.Server;
let base: string;
let home: string;
let lockPath: string;
/** What the device would answer for `/setup-api/harness/active`. */
let activeHarness: string;
let installedApps: string[];
/** `installed_meta` rows, by raw id — a `webappUrl` marks a ClawBox web app. */
let installedMeta: Record<string, { webappUrl?: string }>;
/** Every `ui:pending-action` the CLI posted, newest last. */
let posted: Array<Record<string, unknown>>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/setup-api/harness/active") {
      json({ active: activeHarness });
      return;
    }
    if (req.method === "GET" && url.pathname === "/setup-api/preferences") {
      json({ installed_apps: installedApps, installed_meta: installedMeta });
      return;
    }
    if (req.method === "POST" && url.pathname === "/setup-api/kv") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { value?: string };
          posted.push(JSON.parse(String(body.value ?? "{}")));
        } catch {
          posted.push({});
        }
        json({ ok: true });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cli-home-"));
  lockPath = path.join(home, "edition.env");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  activeHarness = "openclaw";
  installedApps = [];
  installedMeta = {};
  posted = [];
});

/**
 * The ceiling on ONE `bun` spawn, comfortably under vitest's own per-test
 * default so this file's failure is "the CLI hung" rather than "the test timed
 * out". See `cli()`.
 */
const CLI_TIMEOUT_MS = 4_000;

/**
 * A test budget derived from what the test SPAWNS.
 *
 * vitest's 5 s default covers one `bun` start, not five: a multi-spawn test
 * would hit the framework's timeout first, and per the note on `cli()` that
 * neither cancels the promise nor kills the child — exactly the failure this
 * file's timer exists to remove. So every test that spawns more than once says
 * how many, and `CLI_TIMEOUT_MS` stays the thing that fires first on ONE hung
 * child.
 */
function budget(spawns: number): { timeout: number } {
  return { timeout: spawns * CLI_TIMEOUT_MS + 10_000 };
}

/**
 * Run the CLI against the stub device.
 *
 * ASYNC, never `spawnSync`: the stub server lives in THIS process, so blocking
 * the event loop until the child exits would leave the child's own request
 * unanswered forever — the two would wait for each other.
 *
 * KILLED ON ITS OWN CLOCK. `mcp/clawbox-cli.ts`'s `api()` calls fetch with no
 * `signal`, so a device that accepts the connection and never answers blocks
 * the child indefinitely. Resolving only on `close` then hands the timeout to
 * vitest, which fails the test WITHOUT cancelling this promise or killing
 * `bun` — the worker keeps the child through teardown and the run reports a
 * generic timeout over a hung CLI. This is the only test of the CLI gate, so
 * it must not be the thing that hangs.
 */
function cli(
  args: string[],
  edition: string,
  opts: { lockBody?: string; apiBase?: string } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  fs.writeFileSync(lockPath, opts.lockBody ?? `CLAWBOX_EDITION=${edition}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], {
      env: testEnv({
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAWBOX_API_BASE: opts.apiBase ?? base,
        CLAWBOX_EDITION_FILE: lockPath,
        // Long enough to pass the CLI's own length check; the stub device does
        // not look at it.
        CLAWBOX_MCP_TOKEN: "0".repeat(32),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // SIGKILL, not SIGTERM: the point is that the child is wedged, and a
    // handler that never runs would leave it alive exactly as before.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `clawbox ${args.join(" ")} did not exit within ${CLI_TIMEOUT_MS}ms; killed.`
        + ` stdout: ${stdout.trim() || "(none)"} stderr: ${stderr.trim() || "(none)"}`,
      ));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

d("clawbox app open — the edition gate", () => {
  it("opens the Hermes dashboard on a dual box that is running Hermes", async () => {
    activeHarness = "hermes";
    const r = await cli(["app", "open", "hermes"], "dual");
    expect(r.status, r.stderr).toBe(0);
    expect(posted).toContainEqual(expect.objectContaining({ type: "open_app", appId: "hermes" }));
  });

  it("opens an OpenClaw-only app on a dual box that is running OpenClaw", async () => {
    activeHarness = "openclaw";
    const r = await cli(["app", "open", "store"], "dual");
    expect(r.status, r.stderr).toBe(0);
    expect(posted).toContainEqual(expect.objectContaining({ type: "open_app", appId: "store" }));
  });

  it("still refuses the other harness's app on a single-harness box", budget(3), async () => {
    const r = await cli(["app", "open", "hermes"], "openclaw");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No built-in app");
    expect(posted).toEqual([]);
  });

  it("still refuses an id no app claims", budget(3), async () => {
    const r = await cli(["app", "open", "not-an-app"], "hermes");
    expect(r.status).toBe(1);
    expect(posted).toEqual([]);
  });

  it("opens an app the device really installed, and refuses one it did not", budget(2), async () => {
    installedApps = ["notes"];
    expect((await cli(["app", "open", "installed-notes"], "openclaw")).status).toBe(0);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "open_app", appId: "installed-notes" }),
    );
    const missing = await cli(["app", "open", "installed-ledger"], "openclaw");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No installed app");
  });

  it("refuses a store-installed skill on Hermes, and opens a web app", budget(2), async () => {
    // An installed STORE app is an OpenClaw skill: its window shells out to the
    // openclaw binary, so the Hermes desktop drops it from `getAllApps()` and a
    // tick here would be printed over a window that never appears. A ClawBox
    // web app is harness-independent — often the Hermes agent's own output.
    installedApps = ["weather-skill", "notes"];
    installedMeta = { notes: { webappUrl: "/setup-api/webapps?app=notes" } };

    const skill = await cli(["app", "open", "installed-weather-skill"], "hermes");
    expect(skill.status).toBe(1);
    expect(posted).toEqual([]);

    const webapp = await cli(["app", "open", "installed-notes"], "hermes");
    expect(webapp.status, webapp.stderr).toBe(0);
    expect(posted).toContainEqual(expect.objectContaining({ appId: "installed-notes" }));

    // …and on OpenClaw the same skill opens.
    posted = [];
    expect((await cli(["app", "open", "installed-weather-skill"], "openclaw")).status).toBe(0);
  });
});

d("clawbox app open — when the harness cannot be determined", () => {
  // A lock file that EXISTS and carries no edition: a truncated write, a
  // permission change, a partial reflash. The MCP resolves that to the smaller
  // TOOL SET on purpose — an unreadable lock must not hand a device the shell
  // and file tools. The APP sets are not nested, so the same doubt cannot fail
  // closed onto one harness: answering "hermes" hides `store`, `openclaw` and
  // `memory-shard` from a box that has them, and answering "openclaw" ticks off
  // apps a Hermes box does not have. Both sets are hidden and the reason said.
  //
  // The device is NOT asked here, and that is deliberate:
  // /setup-api/harness/active resolves through `readEdition()` — the same file
  // this process just failed to read — so on an unreadable lock it can only
  // echo "openclaw", on a Hermes box as readily as on an OpenClaw one. See
  // mcp/lib/edition.ts.
  const NO_EDITION = "# ClawBox edition lock\n# (truncated)\n";

  it("keeps offering the apps that exist on either harness", async () => {
    const r = await cli(["app", "open", "settings"], "openclaw", { lockBody: NO_EDITION });
    expect(r.status, r.stderr).toBe(0);
    expect(posted).toContainEqual(expect.objectContaining({ appId: "settings" }));
  });

  it("refuses BOTH harnesses' own apps rather than guessing one", budget(5), async () => {
    // The stub device WOULD answer "openclaw" here — that is the point. Taking
    // it would tick off `store` and `openclaw` on a box whose lock nobody could
    // read, and deny a Hermes box its own dashboard.
    activeHarness = "openclaw";
    for (const appId of ["hermes", "hermes-skills", "store", "openclaw", "memory-shard"]) {
      posted = [];
      const r = await cli(["app", "open", appId], "openclaw", { lockBody: NO_EDITION });
      expect(r.status, `${appId} must be refused`).toBe(1);
      // Not "there is no such app": the device may well have it. Ticking off an
      // open the desktop then drops is the false success this gate exists for.
      expect(r.stderr).toMatch(/which harness/i);
      expect(posted).toEqual([]);
    }
  });

  it("lists neither harness's own apps, and says why", async () => {
    const r = await cli(["app", "list"], "openclaw", { lockBody: NO_EDITION });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("settings —");
    for (const appId of ["hermes —", "store —", "openclaw —", "memory-shard —"]) {
      expect(r.stdout).not.toContain(appId);
    }
    expect(r.stdout).toMatch(/harness/i);
  });

  it("refuses them on a dual box the device cannot answer for either", budget(3), async () => {
    // A dual box mid-update: the web server is restarting, so
    // /setup-api/harness/active does not answer. Defaulting to one harness
    // would tell the agent as a durable fact that the box has no dashboard.
    const dead = "http://127.0.0.1:9";
    for (const appId of ["hermes", "store"]) {
      posted = [];
      const r = await cli(["app", "open", appId], "dual", { apiBase: dead });
      expect(r.status, `${appId} must be refused`).toBe(1);
      expect(r.stderr).toMatch(/which harness/i);
      expect(posted).toEqual([]);
    }
    const list = await cli(["app", "list"], "dual", { apiBase: dead });
    expect(list.stdout).not.toContain("hermes —");
    expect(list.stdout).not.toContain("store —");
  });

  it("prints nothing about registering a tool set", async () => {
    // The MCP's fail-closed notice is about tools/list on a long-lived stdio
    // server. A CLI invocation registers nothing, and the line names a path
    // this run may not even be reading.
    const r = await cli(["app", "list"], "openclaw", { lockBody: NO_EDITION });
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/tool set|clawbox-mcp/i);
  });
});

d("clawbox app open — what it may claim happened", () => {
  it("does not report an EXTERNAL app as opened", async () => {
    // `openclaw` and `hermes` are `external: true`: the desktop opens them with
    // window.open() from a POLL rather than a click, so a popup blocker drops
    // the tab with nothing to report back. `ui_open_app` hedges for exactly
    // that reason; the CLI posts the same action to the same ring, so a tick
    // here is the same false success on the one path the agent cannot see —
    // and "one question, three surfaces" is this whole file's subject.
    activeHarness = "hermes";
    const r = await cli(["app", "open", "hermes"], "dual");
    expect(r.status, r.stderr).toBe(0);
    expect(posted.at(-1)).toMatchObject({ type: "open_app", appId: "hermes" });
    expect(r.stdout).not.toMatch(/✅ Opening/);
    expect(r.stdout).toMatch(/new browser tab/);
    expect(r.stdout).toMatch(/popup/i);
  });

  it("still reports an ordinary desktop window as opened", async () => {
    // The counterweight: a real window IS placed by the desktop, and hedging
    // over every app would make the honest note meaningless.
    const r = await cli(["app", "open", "terminal"], "openclaw");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/popup/i);
    expect(r.stdout).toContain("✅ ");
  });

  it("says the SAME SENTENCE ui_open_app says, on both branches", budget(2), async () => {
    // The invariant `openedAppNotice` exists for. Consulted only on the
    // external branch it was half dead, and the ordinary wording was free to
    // drift from the tool's — which is the defect, one surface over.
    for (const [appId, edition] of [["terminal", "openclaw"], ["hermes", "hermes"]] as const) {
      const r = await cli(["app", "open", appId], edition);
      expect(r.status, r.stderr).toBe(0);
      const app = builtInApps(edition).find((a) => a.id === appId);
      expect(app, `${appId} must exist on ${edition}`).toBeTruthy();
      expect(r.stdout).toContain(openedAppNotice(app, appId));
    }
  });

  it("reports an installed web app as opened", async () => {
    // An installed app is framed IN the desktop, not window.open()ed, so it is
    // not external and the tick is true.
    installedApps = ["notes"];
    installedMeta = { notes: { webappUrl: "/setup-api/webapps?app=notes" } };
    const r = await cli(["app", "open", "installed-notes"], "openclaw");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("✅ ");
    expect(r.stdout).toContain("installed-notes");
  });
});

d("clawbox app list — the same answer as the gate", () => {
  it("lists the Hermes apps on a dual box that is running Hermes", async () => {
    activeHarness = "hermes";
    const r = await cli(["app", "list"], "dual");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("hermes —");
    expect(r.stdout).not.toContain("store —");
  });

  it("lists the OpenClaw apps on a dual box that is running OpenClaw", async () => {
    activeHarness = "openclaw";
    const r = await cli(["app", "list"], "dual");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("store —");
    expect(r.stdout).not.toContain("hermes —");
  });

  // One `bun` spawn per listed id, in series — eleven on a Hermes box, each
  // paying bun's own start. That is well past vitest's 5 s default, and a
  // ceiling derived from the work (rather than inherited) is what keeps the
  // failure honest: `CLI_TIMEOUT_MS` still fails a single hung child first.
  it("names every app it would open, and no app it would refuse", budget(12), async () => {
    // The two commands are one gate: a list that offers what `open` refuses is
    // the false success this pair exists to prevent.
    activeHarness = "hermes";
    const listed = (await cli(["app", "list"], "dual")).stdout
      .split("\n")
      .map((line) => /^ {2}(\S+) —/.exec(line)?.[1])
      .filter((id): id is string => Boolean(id));
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) {
      expect((await cli(["app", "open", id], "dual")).status, `app open ${id}`).toBe(0);
    }
  });
});
