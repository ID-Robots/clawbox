/**
 * Ollama — local model runner. In CLAWBOX_TEST_MODE the install.sh
 * skips the actual Ollama install (it's 400MB+ and needs CUDA), so the
 * server-side route reports `running: false`. The happy path here is:
 *
 *   - /setup-api/ollama/status responds with a structured payload
 *   - /setup-api/ollama/search returns JSON (gracefully degrades if the
 *     catalog endpoint is unreachable)
 *
 * Runs at NN=75 between browser (70) and chat (80) since chat may
 * exercise Ollama as the local-AI fallback.
 */
import { test, expect } from "@playwright/test";
import { getOllamaStatus, searchOllama } from "./helpers/setup-api";

test.describe("ollama happy path", () => {
  test("status endpoint returns a well-formed payload", async () => {
    const status = await getOllamaStatus();
    expect(typeof status.running).toBe("boolean");
    expect(Array.isArray(status.models)).toBe(true);
    // standby fields are optional — assert types when present.
    if (status.idleTimeoutMs !== undefined) {
      expect(typeof status.idleTimeoutMs).toBe("number");
    }
  });

  test("search returns JSON results list (or empty when offline)", async () => {
    // The route returns { results } not { models } and may return 502 when
    // ollama.com is unreachable from CI. Treat 502 as a soft skip — the
    // happy path is "the route exists and returns a sane shape when up".
    let result;
    try {
      result = await searchOllama("gemma");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      test.skip(/502|timeout|Failed to search/i.test(msg), `ollama.com unreachable: ${msg}`);
      throw err;
    }
    expect(Array.isArray(result.results)).toBe(true);
    for (const m of result.results) {
      expect(typeof m.name).toBe("string");
    }
  });
});
