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

let server: http.Server;
let base: string;
let home: string;
let lockPath: string;
/** What the device would answer for `/setup-api/harness/active`. */
let activeHarness: string;
let installedApps: string[];
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
      json({ installed_apps: installedApps });
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
  posted = [];
});

/**
 * Run the CLI against the stub device.
 *
 * ASYNC, never `spawnSync`: the stub server lives in THIS process, so blocking
 * the event loop until the child exits would leave the child's own request
 * unanswered forever — the two would wait for each other.
 */
function cli(args: string[], edition: string): Promise<{ status: number; stdout: string; stderr: string }> {
  fs.writeFileSync(lockPath, `CLAWBOX_EDITION=${edition}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], {
      env: testEnv({
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAWBOX_API_BASE: base,
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
    expect((await cli(["app", "open", "installed-notes"], "hermes")).status).toBe(0);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "open_app", appId: "installed-notes" }),
    );
    const missing = await cli(["app", "open", "installed-ledger"], "hermes");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No installed app");
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
