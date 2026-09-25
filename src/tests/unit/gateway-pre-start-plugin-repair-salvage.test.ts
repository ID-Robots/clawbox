import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";
import { repairHelpers } from "@/tests/helpers/gateway-pre-start";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-1198: the BOOT SCRIPT's writer of `data/plugin-repair.json` over a
// damaged store.
//
// `clawbox_plugin_repair_mark` read an unparseable file as `{}` and wrote its
// one row over it — so one torn write, and every other plugin ClawBox had
// switched off lost its "Needs repair" row and the only record that ClawBox,
// not the owner, turned it off. It now keeps what still parses and keeps the
// damaged file beside the store, and recovers EXACTLY what the server's writer
// recovers (`salvagePluginRepairRows`): two writers that disagreed would undo
// each other's recovery on the next boot. Run out of the SHIPPED script.

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

let root: string;

function storePath(): string {
  return path.join(root, "data", "plugin-repair.json");
}

/** File one row through the shipped writer. */
function mark(id: string, stage = "install") {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    repairHelpers(),
    `clawbox_plugin_repair_mark ${id} ${stage} 1 "could not install ${id}" "@openclaw/${id}@1.0.0"`,
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: "/usr/bin:/bin" }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function store(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(storePath(), "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-repair-salvage-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const WHOLE = JSON.stringify({
  codex: { id: "codex", stage: "install", reason: "offline", atMs: 1, disabled: true, spec: "@openclaw/codex@2026.8.1" },
  discord: { id: "@openclaw/discord", stage: "consent", reason: "refused {x} \"q\"", atMs: 2, disabled: true, spec: "" },
  deepseek: { id: "deepseek", stage: "install", reason: "offline", atMs: 3, disabled: true, spec: "clawhub:x" },
}, null, 2);

d("gateway-pre-start — filing a repair row over a damaged store (TASK-1198)", () => {
  it("keeps every row before the tear, files its own, and keeps the damaged file", () => {
    const torn = WHOLE.slice(0, WHOLE.indexOf("\"deepseek\"") + 30);
    writeFileSync(storePath(), torn);

    const r = mark("byteplus");

    expect(r.status).toBe(0);
    expect(Object.keys(store())).toEqual(["codex", "discord", "byteplus"]);
    expect(store().discord.reason).toBe("refused {x} \"q\"");
    expect(store().codex.spec).toBe("@openclaw/codex@2026.8.1");
    expect(readFileSync(`${storePath()}.corrupt`, "utf-8")).toBe(torn);
    // Said in the boot log, where a box that tore its store is looked into.
    expect(r.stderr).toContain("is damaged; recovered 2 row(s)");
  });

  it("leaves a healthy store's other rows alone and keeps no damaged copy", () => {
    writeFileSync(storePath(), WHOLE);

    expect(mark("byteplus").status).toBe(0);

    expect(Object.keys(store())).toEqual(["codex", "discord", "deepseek", "byteplus"]);
    expect(existsSync(`${storePath()}.corrupt`)).toBe(false);
  });

  it("recovers exactly what the server's writer recovers", async () => {
    const { salvagePluginRepairRows } = await import("@/lib/plugin-repair");
    const cases = [
      "",
      "[]",
      "{ not json",
      WHOLE.slice(0, WHOLE.indexOf("\"discord\"") + 3),
      WHOLE.slice(0, WHOLE.length - 2),
      "{\"a\":{\"x\":1},\"b\":nonsense,\"c\":{\"x\":3}}",
      "\uFEFF{\"codex\":{\"id\":\"codex\"}",
      "{\"a\":1,\"b\":{\"x\":2},\"c\":[1]",
      "{\"a\":{\"r\":\"} \\\" {\"},\"b\"",
    ];
    for (const raw of cases) {
      writeFileSync(storePath(), raw);
      rmSync(`${storePath()}.corrupt`, { force: true });

      const r = mark("zz-new");

      expect(r.status, raw).toBe(0);
      const { "zz-new": filed, ...kept } = store();
      expect(filed, raw).toMatchObject({ id: "zz-new", stage: "install" });
      expect(kept, raw).toEqual(salvagePluginRepairRows(raw));
      expect(existsSync(`${storePath()}.corrupt`), raw).toBe(true);
    }
  });
});
