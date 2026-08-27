import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";

// Owner-reported from a live first-boot run: "some models like Mythos are not
// available", on step 4's Anthropic → Subscription tab.
//
// The cause is that Anthropic ships TWO catalogues and this route only ever
// read one. `openclaw models list --provider anthropic` is the API-KEY
// catalogue — 9 models on OpenClaw 2026.7.1, claude-mythos-5 and
// claude-fable-5 among them. The Claude-subscription surface is the same
// plugin's second catalogue, provider id `claude-cli`, and it carries 5:
// opus-4-8 / 4-7 / 4-6, sonnet-5, sonnet-4-6. No Mythos. No Fable. No Haiku.
//
// So the refresh has to ask BOTH, and stamp each API-catalogue model with
// whether the subscription surface carries it. Anything it cannot enumerate
// stays unstamped — unknown is not "no", and a picker that strikes out a
// working model is the same lie in the other direction.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-surface-test" }));

import { refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

/** Minimal stand-in for the openclaw child process the route drives. */
function fakeChild(json: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // The route parses on each stdout chunk, so one chunk is enough.
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
  });
  return child;
}

const ANTHROPIC_LIST = {
  count: 2,
  models: [
    { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
    { key: "anthropic/claude-mythos-5", name: "Claude Mythos 5", contextWindow: 1_000_000 },
  ],
};

const CLAUDE_CLI_LIST = {
  count: 1,
  models: [
    { key: "claude-cli/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Claude CLI)", contextWindow: 200_000 },
  ],
};

function providerOf(call: unknown[]): string {
  const args = call[1] as string[];
  return args[args.indexOf("--provider") + 1];
}

describe("catalog refresh — subscription surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enumerates the Claude-subscription surface alongside the Anthropic API catalogue", async () => {
    mockSpawn.mockImplementation(((_bin: string, args: string[]) => {
      const provider = args[args.indexOf("--provider") + 1];
      return fakeChild(provider === "claude-cli" ? CLAUDE_CLI_LIST : ANTHROPIC_LIST);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    refreshInBackground("anthropic");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    const providers = mockSpawn.mock.calls.map(providerOf);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("claude-cli");
  });

  it("does not go looking for a second surface for a provider that has only one", async () => {
    mockSpawn.mockImplementation(((_bin: string, args: string[]) => {
      const provider = args[args.indexOf("--provider") + 1];
      return fakeChild(provider === "claude-cli" ? CLAUDE_CLI_LIST : ANTHROPIC_LIST);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    refreshInBackground("google");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    expect(providerOf(mockSpawn.mock.calls[0])).toBe("google");
  });
});
