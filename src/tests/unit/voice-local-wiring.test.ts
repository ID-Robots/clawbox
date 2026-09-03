import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * The provider timeout is asked of clawbox-tts.sh, never copied — and only a
 * plain positive integer is one. install.sh's helper applies the same rule,
 * so the two writers of the tts-local-cli entry cannot disagree about one
 * script output.
 */

const configSetMock = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({ runOpenclawConfigSet: (...a: unknown[]) => configSetMock(...a) }));

let dir: string;
function stub(output: string): string {
  const script = path.join(dir, "clawbox-tts.sh");
  writeFileSync(script, `#!/usr/bin/env bash\n[ "$1" = "--provider-timeout-ms" ] && printf '%s\\n' '${output}'\nexit 0\n`);
  chmodSync(script, 0o755);
  return script;
}

beforeEach(() => {
  vi.resetModules();
  configSetMock.mockReset().mockResolvedValue(undefined);
  dir = mkdtempSync(path.join(tmpdir(), "voice-wiring-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readLocalTtsTimeoutMs", () => {
  it.each([["85000", 85000], ["1.5", null], ["100ms", null], ["0", null], ["", null], ["-5", null]])(
    "reads %j as %j", async (output, expected) => {
      const { readLocalTtsTimeoutMs } = await import("@/lib/voice-local-wiring");
      expect(await readLocalTtsTimeoutMs(stub(output))).toBe(expected);
    },
  );
});

describe("wireLocalVoice", () => {
  it("writes the same provider entry install.sh does, into the home it is told", async () => {
    const script = stub("85000");
    const { wireLocalVoice } = await import("@/lib/voice-local-wiring");
    const res = await wireLocalVoice("messages.tts", script);
    expect(res).toEqual({ ok: true, provider: { command: script, args: ["--", "{{Text}}", "{{OutputPath}}"], outputFormat: "wav", timeoutMs: 85000 } });
    expect(configSetMock).toHaveBeenCalledWith(["messages.tts.providers.tts-local-cli", JSON.stringify(res.ok ? res.provider : null), "--json"]);
  });

  it("never points the gateway at a script that is not there, or one with no usable timeout", async () => {
    const { wireLocalVoice } = await import("@/lib/voice-local-wiring");
    expect(await wireLocalVoice("tts", path.join(dir, "missing.sh"))).toEqual({ ok: false, reason: "script_missing" });
    expect(await wireLocalVoice("tts", stub("soon"))).toEqual({ ok: false, reason: "no_timeout" });
    expect(configSetMock).not.toHaveBeenCalled();
  });
});
