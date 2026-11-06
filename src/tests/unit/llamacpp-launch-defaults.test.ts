import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLAMACPP_CACHE_TYPE,
  DEFAULT_LLAMACPP_CONTEXT_WINDOW,
  DEFAULT_LLAMACPP_MAX_TOKENS,
  SUPERSEDED_LLAMACPP_CACHE_TYPE,
  SUPERSEDED_LLAMACPP_CONTEXT_WINDOW,
  SUPERSEDED_LLAMACPP_MAX_TOKENS,
} from "@/lib/llamacpp";

/**
 * How llama-server is launched — its window and KV-cache types — and what
 * OpenClaw is told about it are written in five places no compiler links:
 * src/lib/llamacpp.ts (the app), install.sh and install-x64.sh (the .env every
 * device carries), scripts/start-llamacpp.sh (the launcher's own fallback) and
 * scripts/gateway-pre-start.sh (the provider row it repairs and resizes). A box
 * whose server runs one window while OpenClaw is told another sizes every
 * prompt for a window that is not there.
 *
 * Read as text, as llamacpp-gguf-pin.test.ts reads the GGUF pin.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (name: string) => readFileSync(path.join(REPO_ROOT, name), "utf8");
const INSTALLERS = ["install.sh", "install-x64.sh"] as const;

// The measured config (reports/clawbox/local-ai/BENCHMARK.md). Spelled out so a
// change to the constants alone cannot make this test agree with itself.
const EXPECTED = { ctx: 32768, maxTokens: 8192, cache: "q8_0" };
const SUPERSEDED = { ctx: 131072, maxTokens: 131072, cache: "q4_0" };

describe("llama.cpp launch defaults", () => {
  it("are the measured ones", () => {
    expect(DEFAULT_LLAMACPP_CONTEXT_WINDOW).toBe(EXPECTED.ctx);
    expect(DEFAULT_LLAMACPP_MAX_TOKENS).toBe(EXPECTED.maxTokens);
    expect(DEFAULT_LLAMACPP_CACHE_TYPE).toBe(EXPECTED.cache);
    expect(SUPERSEDED_LLAMACPP_CONTEXT_WINDOW).toBe(SUPERSEDED.ctx);
    expect(SUPERSEDED_LLAMACPP_MAX_TOKENS).toBe(SUPERSEDED.maxTokens);
    expect(SUPERSEDED_LLAMACPP_CACHE_TYPE).toBe(SUPERSEDED.cache);
  });

  it.each(INSTALLERS)("%s writes them into .env", (installer) => {
    const src = read(installer);
    expect(src).toContain(`ensure_env_setting "$ENV_FILE" "LLAMACPP_CONTEXT_WINDOW" "${EXPECTED.ctx}"`);
    expect(src).toContain(`ensure_env_setting "$ENV_FILE" "LLAMACPP_MAX_TOKENS" "${EXPECTED.maxTokens}"`);
    expect(src).toContain(`ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_K" "${EXPECTED.cache}"`);
    expect(src).toContain(`ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_V" "${EXPECTED.cache}"`);
  });

  it.each(INSTALLERS)("%s moves a device off exactly the superseded values, before it ensures the new ones", (installer) => {
    const src = read(installer);
    const pairs = [
      ["LLAMACPP_CONTEXT_WINDOW", SUPERSEDED.ctx, EXPECTED.ctx],
      ["LLAMACPP_CACHE_TYPE_K", SUPERSEDED.cache, EXPECTED.cache],
      ["LLAMACPP_CACHE_TYPE_V", SUPERSEDED.cache, EXPECTED.cache],
      ["LLAMACPP_MAX_TOKENS", SUPERSEDED.maxTokens, EXPECTED.maxTokens],
    ] as const;
    for (const [key, from, to] of pairs) {
      const migrate = `migrate_env_setting "$ENV_FILE" "${key}" "${from}" "${to}"`;
      const ensure = `ensure_env_setting "$ENV_FILE" "${key}" "${to}"`;
      expect(src.indexOf(migrate), `${installer}: ${migrate}`).toBeGreaterThan(-1);
      // ensure_env_setting never overwrites, so the migration must run first.
      expect(src.indexOf(migrate)).toBeLessThan(src.indexOf(ensure));
    }
    // No stale default left behind anywhere in the installer.
    expect(src).not.toMatch(/ensure_env_setting "\$ENV_FILE" "LLAMACPP_(CONTEXT_WINDOW|MAX_TOKENS)" "131072"/);
    expect(src).not.toMatch(/ensure_env_setting "\$ENV_FILE" "LLAMACPP_CACHE_TYPE_[KV]" "q4_0"/);
  });

  it("the launcher falls back to the same KV cache type", () => {
    const src = read("scripts/start-llamacpp.sh");
    expect(src).toContain(`CACHE_TYPE_K="\${LLAMACPP_CACHE_TYPE_K:-${EXPECTED.cache}}"`);
    expect(src).toContain(`CACHE_TYPE_V="\${LLAMACPP_CACHE_TYPE_V:-${EXPECTED.cache}}"`);
  });

  it("the gateway pre-start writes and resizes rows to the same window and answer budget", () => {
    const src = read("scripts/gateway-pre-start.sh");
    expect(src).toContain(`_ctx = _llamacpp_int(_llamacpp_setting("LLAMACPP_CONTEXT_WINDOW"), 16384, ${EXPECTED.ctx})`);
    expect(src).toContain(`_max_tokens = min(_llamacpp_int(_llamacpp_setting("LLAMACPP_MAX_TOKENS"), 1, ${EXPECTED.maxTokens}), _ctx)`);
  });

  it(".env.example documents the same values", () => {
    const src = read(".env.example");
    expect(src).toContain(`# LLAMACPP_CONTEXT_WINDOW=${EXPECTED.ctx}`);
    expect(src).toContain(`# LLAMACPP_MAX_TOKENS=${EXPECTED.maxTokens}`);
    expect(src).toContain(`# LLAMACPP_CACHE_TYPE_K=${EXPECTED.cache}`);
    expect(src).toContain(`# LLAMACPP_CACHE_TYPE_V=${EXPECTED.cache}`);
  });
});
