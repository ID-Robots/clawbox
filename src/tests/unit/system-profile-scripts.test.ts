import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The `--check` contract of the three TASK-455 shell scripts, exercised by
 * actually running them.
 *
 * These are the modes the setup-api status route calls, and the ONLY modes it
 * calls without sudo — so "check changes nothing and prints one parseable JSON
 * object" is a contract the TypeScript side depends on, not a nicety. They are
 * run for real rather than mocked because the thing that breaks is the shell,
 * not our idea of the shell.
 *
 * Everything is driven through the CLAWBOX_* overrides the scripts expose, so
 * nothing here reads or writes real system state.
 */

const REPO = process.cwd();
const DESKTOP = path.join(REPO, "scripts", "clawbox-desktop-mode.sh");
const POWER = path.join(REPO, "scripts", "clawbox-power-mode.sh");
const LIMITS = path.join(REPO, "scripts", "clawbox-resource-limits.sh");
const OLLAMA = path.join(REPO, "scripts", "optimize-ollama.sh");

function run(script: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("bash", [script, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

/** The parser src/lib/system-profile.ts uses: the LAST JSON object printed. */
function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));
  expect(lines.length, `no JSON object in:\n${stdout}`).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-455-"));
}

describe("clawbox-desktop-mode.sh --check", () => {
  it("prints one JSON object with the full status shape", () => {
    const out = lastJson(run(DESKTOP, ["--check"]));
    expect(Object.keys(out).sort()).toEqual([
      "active", "defaultTarget", "displayManager", "enabled", "rebootRequired", "supported",
    ]);
    expect(typeof out.supported).toBe("boolean");
    expect(typeof out.enabled).toBe("boolean");
    expect(typeof out.active).toBe("boolean");
    expect(typeof out.rebootRequired).toBe("boolean");
    expect(typeof out.defaultTarget).toBe("string");
  });

  it("reports rebootRequired exactly when intent and live state disagree", () => {
    // The whole point of the field: `enabled` is the boot target, `active` is
    // what the box is doing now, and they differ only between a toggle and the
    // reboot that applies it.
    const out = lastJson(run(DESKTOP, ["--check"]));
    expect(out.rebootRequired).toBe(out.enabled !== out.active);
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(() => run(DESKTOP, ["--wat"])).toThrow();
  });

  it("refuses to mutate as a non-root user", () => {
    // Guards the case where the sudoers grant is missing: the script must fail
    // loudly rather than half-apply a target change it cannot make.
    if (process.getuid?.() === 0) return;
    expect(() => run(DESKTOP, ["--disable"])).toThrow();
  });
});

describe("clawbox-power-mode.sh --check", () => {
  const conf = path.join(tmpdir(), "nvpmodel.conf");
  fs.writeFileSync(
    conf,
    "< POWER_MODEL ID=0 NAME=15W >\n< POWER_MODEL ID=1 NAME=25W >\n< POWER_MODEL ID=2 NAME=MAXN_SUPER >\n",
  );

  it("prints one JSON object with the full status shape", () => {
    const state = tmpdir();
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: conf,
      CLAWBOX_STATE_DIR: state,
    }));
    expect(Object.keys(out).sort()).toEqual([
      "balancedId", "clocksPinned", "mode", "nvpmodelId", "nvpmodelName",
      "performanceId", "supported",
    ]);
  });

  it("resolves balanced to the highest non-MAXN mode and performance to MAXN", () => {
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: conf,
      CLAWBOX_STATE_DIR: tmpdir(),
    }));
    expect(out.balancedId).toBe(1);     // 25W
    expect(out.performanceId).toBe(2);  // MAXN_SUPER
  });

  it("defaults to balanced when nothing is persisted", () => {
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: conf,
      CLAWBOX_STATE_DIR: tmpdir(),
    }));
    expect(out.mode).toBe("balanced");
  });

  it("reads the persisted profile back", () => {
    const state = tmpdir();
    fs.writeFileSync(path.join(state, "power-mode"), "performance\n");
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: conf,
      CLAWBOX_STATE_DIR: state,
    }));
    expect(out.mode).toBe("performance");
  });

  it("falls back to balanced when the state file holds junk", () => {
    // The file is root-owned, but a truncated write or a hand-edit must never
    // leave the box pinned by accident — the safe default is the cool one.
    const state = tmpdir();
    fs.writeFileSync(path.join(state, "power-mode"), "MAXN; rm -rf /\n");
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: conf,
      CLAWBOX_STATE_DIR: state,
    }));
    expect(out.mode).toBe("balanced");
  });

  it("still emits valid JSON with no nvpmodel.conf at all", () => {
    const out = lastJson(run(POWER, ["--check"], {
      CLAWBOX_NVPMODEL_CONF: "/nonexistent/nvpmodel.conf",
      CLAWBOX_STATE_DIR: tmpdir(),
    }));
    expect(out.performanceId).toBeNull();
    expect(out.mode).toBe("balanced");
  });

  it("rejects an unknown mode", () => {
    expect(() => run(POWER, ["--wat"])).toThrow();
  });

  it("refuses to mutate as a non-root user", () => {
    if (process.getuid?.() === 0) return;
    expect(() => run(POWER, ["--performance"])).toThrow();
  });
});

describe("clawbox-resource-limits.sh --check", () => {
  it("reports the drop-in it would write for every managed unit, and writes nothing", () => {
    const systemd = tmpdir();
    const out = run(LIMITS, ["--check"], { CLAWBOX_SYSTEMD_DIR: systemd });
    expect(out).toContain("ollama.service");
    expect(out).toContain("clawbox-embed.service");
    expect(out).toContain("clawbox-browser.service");
    expect(out).toContain("user@1000.service");
    expect(out).toContain("result: no changes made (--check)");
    expect(fs.readdirSync(systemd)).toEqual([]);
  });

  it("takes its numbers from the env file, not from itself", () => {
    const limits = path.join(tmpdir(), "limits.env");
    fs.writeFileSync(limits, [
      "CLAWBOX_OLLAMA_MEMORY_HIGH=3G",
      "CLAWBOX_OLLAMA_MEMORY_MAX=4G",
      "CLAWBOX_EMBED_MEMORY_HIGH=500M",
      "CLAWBOX_EMBED_MEMORY_MAX=600M",
      "CLAWBOX_BROWSER_MEMORY_HIGH=100M",
      "CLAWBOX_BROWSER_MEMORY_MAX=200M",
      "CLAWBOX_DESKTOP_MEMORY_HIGH=300M",
      "CLAWBOX_DESKTOP_MEMORY_MAX=400M",
    ].join("\n") + "\n");
    const out = run(LIMITS, ["--check"], {
      CLAWBOX_RESOURCE_LIMITS_FILE: limits,
      CLAWBOX_SYSTEMD_DIR: tmpdir(),
    });
    // Each cap named WITH its unit: the bare pair also matched when the script
    // printed the right numbers beside the wrong unit.
    expect(out).toContain("unit: ollama.service MemoryHigh=3G MemoryMax=4G");
    expect(out).toContain("unit: clawbox-embed.service MemoryHigh=500M MemoryMax=600M");
    expect(out).toContain("unit: clawbox-browser.service MemoryHigh=100M MemoryMax=200M");
    expect(out).toContain("unit: user@1000.service MemoryHigh=300M MemoryMax=400M");
  });

  it("skips a unit whose keys an older env file lacks, and still caps the rest", () => {
    // The root-owned env on a box mid-update predates the embedder's keys.
    // Aborting would leave ollama, the browser and the desktop uncapped too.
    const limits = path.join(tmpdir(), "limits.env");
    fs.writeFileSync(limits, [
      "CLAWBOX_OLLAMA_MEMORY_HIGH=3G",
      "CLAWBOX_OLLAMA_MEMORY_MAX=4G",
      "CLAWBOX_BROWSER_MEMORY_HIGH=100M",
      "CLAWBOX_BROWSER_MEMORY_MAX=200M",
      "CLAWBOX_DESKTOP_MEMORY_HIGH=300M",
      "CLAWBOX_DESKTOP_MEMORY_MAX=400M",
    ].join("\n") + "\n");
    const out = run(LIMITS, ["--check"], {
      CLAWBOX_RESOURCE_LIMITS_FILE: limits,
      CLAWBOX_SYSTEMD_DIR: tmpdir(),
    });
    expect(out).toContain("unit: ollama.service MemoryHigh=3G MemoryMax=4G");
    expect(out).toContain("unit: user@1000.service MemoryHigh=300M MemoryMax=400M");
    expect(out).not.toContain("clawbox-embed.service MemoryHigh");
  });

  it("fails loudly on a malformed limits file rather than writing a broken unit", () => {
    const limits = path.join(tmpdir(), "limits.env");
    fs.writeFileSync(limits, "CLAWBOX_OLLAMA_MEMORY_HIGH=$(reboot)\n");
    expect(() => run(LIMITS, ["--check"], {
      CLAWBOX_RESOURCE_LIMITS_FILE: limits,
      CLAWBOX_SYSTEMD_DIR: tmpdir(),
    })).toThrow();
  });

  it("--apply writes the four drop-ins and is idempotent", () => {
    // Runs against a temp systemd dir, so this exercises the writer without
    // touching /etc. daemon-reload/set-property are best-effort no-ops here.
    const systemd = tmpdir();
    if (process.getuid?.() !== 0) return; // --apply requires root by design
    run(LIMITS, ["--apply"], {
      CLAWBOX_SYSTEMD_DIR: systemd,
      CLAWBOX_RESOURCE_LIMITS_FILE: path.join(process.cwd(), "config", "clawbox-resource-limits.env"),
    });
    const first = fs.readdirSync(systemd).sort();
    expect(first).toEqual([
      "clawbox-browser.service.d", "clawbox-embed.service.d", "ollama.service.d", "user@1000.service.d",
    ]);
    run(LIMITS, ["--apply"], { CLAWBOX_SYSTEMD_DIR: systemd });
    expect(fs.readdirSync(systemd).sort()).toEqual(first);
  });

  it("refuses --apply as a non-root user", () => {
    if (process.getuid?.() === 0) return;
    expect(() => run(LIMITS, ["--apply"], { CLAWBOX_SYSTEMD_DIR: tmpdir() })).toThrow();
  });
});

describe("optimize-ollama.sh --check", () => {
  it("reports the concurrency and context length it would write", () => {
    const out = run(OLLAMA, ["--check"]);
    expect(out).toContain("OLLAMA_NUM_PARALLEL=2");
    expect(out).toContain("OLLAMA_CONTEXT_LENGTH=4096");
    expect(out).toContain("result: no changes made (--check)");
  });

  it("reads those values from the limits file", () => {
    const limits = path.join(tmpdir(), "limits.env");
    fs.writeFileSync(limits, "CLAWBOX_OLLAMA_NUM_PARALLEL=4\nCLAWBOX_OLLAMA_CONTEXT_LENGTH=8192\n");
    const out = run(OLLAMA, ["--check"], { CLAWBOX_RESOURCE_LIMITS_FILE: limits });
    expect(out).toContain("OLLAMA_NUM_PARALLEL=4");
    expect(out).toContain("OLLAMA_CONTEXT_LENGTH=8192");
  });
});
