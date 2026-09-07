import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

/**
 * The Hermes side of the ClawBox AI credential stand-down (TASK-727).
 *
 * When the proxy REFUSES this box's credential, ClawBox records the fact
 * (`clawai_credential_refused_at` in the device store — refreshed on every
 * refusal, never write-once, so the stamp always belongs to the credential the
 * box holds now) and stands the image path down, because there is no back-off
 * anywhere downstream: the plugin
 * spends refused calls for as long as the box is switched on — 6,554 in twelve
 * hours from one box. `gateway-pre-start.sh` has read that record since the fix
 * landed; this script never did, and it is the one that puts the image backend
 * BACK. So on the boot after a plugin-list repair, a Hermes box re-armed itself
 * over a credential it had been told was dead, and the storm started again with
 * nobody looking.
 *
 * The re-arm's other four conditions are pinned here too, because the gate must
 * not be the only thing standing between a refused box and the arm.
 */

// Starts real processes (bash + python3): vitest's 5 s default is not enough.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCRIPT = path.join(process.cwd(), "scripts", "register-mcp.sh");

function have(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN =
  have("bash", ["-c", "true"]) && have("python3", ["-c", "import yaml"]);
const d = CAN_RUN ? describe : describe.skip;

let home: string;
let root: string;
let configPath: string;
let lockPath: string;

function run(): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: lockPath,
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

/** The device store the boot scripts read, with whatever this case wants in it. */
function writeDeviceStore(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(entries));
}

/**
 * The one state the re-arm fires in: `plugins.enabled` stored as TEXT (which
 * loads no plugins at all) naming the backend, with the backend's files really
 * on disk and nobody's choice in `image_gen.provider`.
 */
function writeRepairableConfig(): void {
  fs.mkdirSync(path.join(home, ".hermes", "plugins", "image_gen", "clawai"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".hermes", "plugins", "image_gen", "clawai", "__init__.py"),
    "# stand-in for the linked backend\n",
  );
  fs.writeFileSync(configPath, "plugins:\n  enabled: 'clawai'\n");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-rearm-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-rearm-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  lockPath = path.join(home, "edition.env");

  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
  writeRepairableConfig();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("the ClawAI image backend is not re-armed over a refused credential", () => {
  it("leaves image_gen.provider unset, and says why", () => {
    writeDeviceStore({ clawai_token: "claw_x", clawai_credential_refused_at: Date.now() });

    const res = run();

    expect(res.status).toBe(0);
    const cfg = readConfig();
    expect(
      (cfg.image_gen as Record<string, unknown> | undefined)?.provider,
      `the backend was armed over a refused credential:\n${res.stdout}${res.stderr}`,
    ).toBeUndefined();
    expect(`${res.stdout}${res.stderr}`).toMatch(/credential was refused/);
  });

  it("still re-arms a box nobody has been told about", () => {
    // The other side, and the reason the gate is a fifth condition rather than
    // a new default: the repair exists so a box whose plugin list was stored as
    // text stops reporting that it cannot draw. Absent, unreadable and
    // malformed records all mean "nobody has told us this credential is dead".
    writeDeviceStore({ clawai_token: "claw_x" });

    const res = run();

    expect(res.status).toBe(0);
    expect((readConfig().image_gen as Record<string, unknown>).provider).toBe("clawai");
    expect(`${res.stdout}${res.stderr}`).toMatch(/re-armed image_gen\.provider/);
  });

  it("reads a malformed record as nothing having been said", () => {
    // Same collapse as `_clawai_credential_refused` in gateway-pre-start.sh:
    // a value that is not a positive number is not a refusal, and a box we have
    // not been told about is left as it is.
    writeDeviceStore({ clawai_credential_refused_at: "yesterday" });

    const res = run();

    expect(res.status).toBe(0);
    expect((readConfig().image_gen as Record<string, unknown>).provider).toBe("clawai");
  });

  it("says so out loud when the store cannot be READ, and still leaves the box alone", () => {
    // Absent and unreadable collapse to the same answer on purpose — the
    // sibling gate in gateway-pre-start.sh does the same, and this script runs
    // as clawbox where that one runs as root, so a root-owned config.json lands
    // here — but they are not the same event. Silence would let the log print
    // "re-armed image_gen.provider" as though all five conditions had been
    // weighed.
    fs.mkdirSync(path.join(root, "data", "config.json"), { recursive: true });

    const res = run();

    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/could not read the device store/);
    expect((readConfig().image_gen as Record<string, unknown>).provider).toBe("clawai");
  });

  it("does not arm over a backend somebody already chose", () => {
    // Condition 3, pinned beside the new one: `image_gen.provider` that already
    // names something is a choice — ours or the owner's — and not this script's
    // to move.
    writeDeviceStore({});
    fs.writeFileSync(configPath, "plugins:\n  enabled: 'clawai'\nimage_gen:\n  provider: someone-elses\n");

    const res = run();

    expect(res.status).toBe(0);
    expect((readConfig().image_gen as Record<string, unknown>).provider).toBe("someone-elses");
  });
});
