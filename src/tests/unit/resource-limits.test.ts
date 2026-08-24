import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  RESOURCE_LIMITS,
  RESOURCE_LIMIT_KEYS,
  parseSystemdSize,
} from "@/lib/resource-limits";

/**
 * TASK-455 deliverable 3 says the memory guards live "as constants in one
 * place". config/clawbox-resource-limits.env IS that place — it is what the
 * shell scripts read at runtime — and src/lib/resource-limits.ts is a mirror
 * the bundled web server can read without shipping config/.
 *
 * A mirror that can drift is worse than no mirror: the UI would state a limit
 * the box is not actually enforcing. So this file re-parses the env file with
 * the same rule the shell uses and asserts the two agree, key by key.
 */

const ENV_FILE = path.join(process.cwd(), "config", "clawbox-resource-limits.env");

/** The shell side's parser, in TypeScript: `KEY=<digits><optional suffix>`. */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(\d+[KMGT]?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("resource limits (TASK-455)", () => {
  const raw = fs.readFileSync(ENV_FILE, "utf-8");
  const env = parseEnvFile(raw);

  it("the env file parses to the keys the scripts ask for", () => {
    expect(Object.keys(env).sort()).toEqual(Object.keys(RESOURCE_LIMIT_KEYS).sort());
  });

  for (const [key, mirrored] of Object.entries(RESOURCE_LIMIT_KEYS)) {
    it(`${key} matches the TypeScript mirror`, () => {
      expect(env[key], `${key} missing from ${ENV_FILE}`).toBeDefined();
      expect(env[key]).toBe(String(mirrored));
    });
  }

  it("every memory value is a size systemd accepts", () => {
    for (const key of Object.keys(env)) {
      if (!key.includes("MEMORY")) continue;
      expect(parseSystemdSize(env[key]), `${key} = ${env[key]}`).toBeGreaterThan(0);
    }
  });

  describe("the numbers are internally coherent", () => {
    const units = [
      ["ollama", RESOURCE_LIMITS.ollama],
      ["browser", RESOURCE_LIMITS.browser],
      ["desktop", RESOURCE_LIMITS.desktop],
    ] as const;

    for (const [name, limit] of units) {
      it(`${name}: MemoryHigh is below MemoryMax`, () => {
        // High is the throttle, Max is the kill line. High >= Max would mean
        // the unit is OOM-killed before it is ever throttled, i.e. the whole
        // "degrade before you die" design is inverted.
        const high = parseSystemdSize(limit.memoryHigh)!;
        const max = parseSystemdSize(limit.memoryMax)!;
        expect(high).toBeLessThan(max);
      });

      it(`${name}: MemoryMax fits inside the device's RAM`, () => {
        const max = parseSystemdSize(limit.memoryMax)!;
        expect(max).toBeLessThan(RESOURCE_LIMITS.memTotalMiB * 1024 * 1024);
      });
    }

    it("no single unit may claim the whole box", () => {
      // The guards deliberately over-subscribe (the desktop and the browser are
      // only up when someone is looking at the box), but any ONE of them being
      // allowed to reach MemTotal would make it useless as a guard.
      const total = RESOURCE_LIMITS.memTotalMiB * 1024 * 1024;
      for (const [, limit] of units) {
        expect(parseSystemdSize(limit.memoryMax)!).toBeLessThan(total * 0.8);
      }
    });
  });

  describe("ollama concurrency", () => {
    it("serves more than one request at a time", () => {
      // The finding: NUM_PARALLEL=1 made the 8th concurrent caller wait 24.5 s
      // with throughput flat at 0.34 req/s. On a device where the agent and the
      // human share one model, two consumers is the normal case.
      expect(RESOURCE_LIMITS.ollamaNumParallel).toBeGreaterThanOrEqual(2);
    });

    it("pins a context length rather than inheriting ollama's default", () => {
      expect(RESOURCE_LIMITS.ollamaContextLength).toBeGreaterThan(0);
    });
  });

  describe("parseSystemdSize", () => {
    it("understands the suffixes systemd uses", () => {
      expect(parseSystemdSize("512")).toBe(512);
      expect(parseSystemdSize("1K")).toBe(1024);
      expect(parseSystemdSize("1M")).toBe(1024 ** 2);
      expect(parseSystemdSize("5G")).toBe(5 * 1024 ** 3);
    });

    it("rejects anything else", () => {
      for (const bad of ["", "5 G", "5GB", "-1M", "abc", "1.5G"]) {
        expect(parseSystemdSize(bad), bad).toBeNull();
      }
    });
  });

  it("documents the reasoning next to the numbers", () => {
    // The env file is the only place the measurements behind these values are
    // written down. A future edit that strips it to bare KEY=VALUE lines loses
    // the reason anyone picked 5G, so hold the line here.
    expect(raw).toContain("TASK-455");
    expect(raw.split("\n").filter((l) => l.trimStart().startsWith("#")).length)
      .toBeGreaterThan(20);
  });
});
