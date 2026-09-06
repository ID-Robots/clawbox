import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-742 — what `POST /setup-api/tts` writes into the journal when a write
 * fails, and why alert #464 outlived the fix that was aimed at it.
 *
 * The card, and the note over `ACTIONS` in the route, both read the alert as
 * being about the ACTION name. It is not. Run against the query itself, the
 * reported flow is
 *
 *   `req.json()` -> `body.voice` -> `handleVoice` ->
 *   `runOpenclawConfigSet([…, voice])` -> the CLI's failure ->
 *   `openclaw-config.ts`'s wrapper -> `err` -> `console.warn(…, err)`
 *
 * and it ends at the SECOND argument. `ACTIONS.find` was a barrier the query
 * accepts all along; the failure line's other half was never bounded at all,
 * so an `openclaw` stderr — which quotes the request's own strings — reached
 * the journal at whatever length and with whatever newlines it carried.
 *
 * What is pinned here is the RECORD: one failure, one line, capped, whatever
 * the harness said. The `language` action is the shortest way to a thrown
 * write; the rule belongs to the `catch`, which every action shares.
 */

const writeStateMock = vi.fn();

vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: async () => ({}),
  writeVoiceState: (...a: unknown[]) => writeStateMock(...a),
  readLocalVoice: async () => null,
  writeLocalVoice: vi.fn(async () => {}),
}));

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: async () => ({}),
  runOpenclawConfigSet: vi.fn(async () => {}),
  openclawIsAbsent: () => false,
}));

// `@/lib/config-store` is deliberately NOT mocked: the suite already points
// `CLAWBOX_ROOT` at a temp directory of its own, and a factory that named only
// the two functions this route reaches would drop `DATA_DIR` — the mock hole
// #755 closed in three files and #756 re-opened in a fourth.

function post(body: unknown) {
  return new Request("http://box/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A message shaped like the one the openclaw CLI hands back: the failing
// assignment quoted, then the child's stderr, then more of it than a log line
// should ever carry.
const CLI_STDERR = [
  "openclaw config set failed",
  "  path: tts.providers.openai.voice",
  `  stderr: ${"z".repeat(400)}`,
].join(String.fromCharCode(10));

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  writeStateMock.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a failed voice write writes one bounded journal line", () => {
  it("logs the harness's message as one capped, quoted value", async () => {
    writeStateMock.mockRejectedValue(new Error(CLI_STDERR));
    const { POST } = await import("@/app/setup-api/tts/route");

    const res = await POST(post({ action: "language", language: "en" }));
    expect(res.status).toBe(500);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [prefix, detail] = warnSpy.mock.calls[0] as [string, unknown];
    // The action still names itself, out of the route's own literal list.
    expect(prefix).toBe("[setup-api/tts] language failed:");
    // …and the harness's words are a STRING the route bounded, never the Error
    // object, whose `console` rendering is unbounded and multi-line.
    expect(typeof detail).toBe("string");
    const line = detail as string;
    expect(line.split(String.fromCharCode(10))).toHaveLength(1);
    expect(line).toContain("openclaw config set failed");
    expect(line).toContain("chars]");
    expect(line.length).toBeLessThan(300);
  });

  it("says as much about a thrown value that is not an Error", async () => {
    // A rejected promise carrying a bare string reaches the same line, and a
    // bound that only covered `Error` would leave that one unbounded.
    writeStateMock.mockRejectedValue(`refused${String.fromCharCode(10)}WARN root login accepted`);
    const { POST } = await import("@/app/setup-api/tts/route");

    const res = await POST(post({ action: "language", language: "en" }));
    expect(res.status).toBe(500);

    const line = String((warnSpy.mock.calls[0] as [string, unknown])[1]);
    expect(line.split(String.fromCharCode(10))).toHaveLength(1);
    expect(line).not.toContain(`${String.fromCharCode(10)}WARN`);
  });
});
