import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

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
 * Run the CLI against the stub device.
 *
 * ASYNC, never `spawnSync`: the stub server lives in THIS process, so blocking
 * the event loop until the child exits would leave the child's own request
 * unanswered forever — the two would wait for each other.
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
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
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

  it("still refuses the other harness's app on a single-harness box", async () => {
    const r = await cli(["app", "open", "hermes"], "openclaw");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No built-in app");
    expect(posted).toEqual([]);
  });

  it("still refuses an id no app claims", async () => {
    const r = await cli(["app", "open", "not-an-app"], "hermes");
    expect(r.status).toBe(1);
    expect(posted).toEqual([]);
  });

  it("opens an app the device really installed, and refuses one it did not", async () => {
    installedApps = ["notes"];
    expect((await cli(["app", "open", "installed-notes"], "openclaw")).status).toBe(0);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "open_app", appId: "installed-notes" }),
    );
    const missing = await cli(["app", "open", "installed-ledger"], "openclaw");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No installed app");
  });

  it("refuses a store-installed skill on Hermes, and opens a web app", async () => {
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
  // and file tools. Apps are not a subset of one another, though: answering
  // "hermes" there hides `store`, `openclaw` and `memory-shard` from a box
  // that has them and ticks off `hermes` on a box that may not. The desktop's
  // own rule for an unknown harness is to hide BOTH sets and say so.
  const NO_EDITION = "# ClawBox edition lock\n# (truncated)\n";

  it("keeps offering the apps that exist on either harness", async () => {
    const r = await cli(["app", "open", "settings"], "openclaw", { lockBody: NO_EDITION });
    expect(r.status, r.stderr).toBe(0);
    expect(posted).toContainEqual(expect.objectContaining({ appId: "settings" }));
  });

  it("refuses BOTH harnesses' own apps rather than guessing one", async () => {
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

  it("does not report a harness it never resolved when the device cannot answer", async () => {
    // A dual box mid-update: the web server is restarting, so
    // /setup-api/harness/active does not answer. Defaulting to one harness
    // would tell the agent as a durable fact that the box has no dashboard.
    const dead = "http://127.0.0.1:9";
    const open = await cli(["app", "open", "hermes"], "dual", { apiBase: dead });
    expect(open.status).toBe(1);
    expect(open.stderr).toMatch(/which harness/i);
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

  it("names every app it would open, and no app it would refuse", async () => {
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
