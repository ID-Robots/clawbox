/**
 * Where a run's transcript is, per provider.
 *
 * Why it exists: on a real box (2026-09-24) every Anthropic-account run's Live
 * terminal said "No transcript yet" for the whole run. The preview was pointed
 * at ~/.claude-ds/projects/…, but since #837 scripts/claude-ds unsets
 * CLAUDE_CONFIG_DIR on the Anthropic branch, so Claude Code writes that run's
 * transcript under its default ~/.claude instead. Only ClawBox AI runs keep
 * their state in ~/.claude-ds (or CLAUDE_DS_CONFIG_DIR).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { harnessStateDir, transcriptPath } from "@/lib/coding-agent";

const SESSION = "1dd8db8b-5c1e-4f0a-9d2b-3e4f5a6b7c8d";

let base: string;
let home: string;
let restore: () => void;

beforeEach(() => {
  restore = saveEnv("HOME", "CLAUDE_DS_CONFIG_DIR", "CLAUDE_CONFIG_DIR");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-transcript-path-"));
  home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.CLAUDE_DS_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

const directory = () => path.join(home, "Projects", "pr-watchdog", ".clawbox", "worktrees", "run-98g5lzv8");
const encoded = () => directory().replace(/[^a-zA-Z0-9]/g, "-");
const fileUnder = (stateDir: string) => path.join(stateDir, "projects", encoded(), `${SESSION}.jsonl`);

function writeTranscript(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
}

describe("the harness state folder mirrors scripts/claude-ds", () => {
  it("is Claude Code's default ~/.claude for an Anthropic run", () => {
    expect(harnessStateDir("anthropic")).toBe(path.join(home, ".claude"));
  });

  it("is ~/.claude-ds for a ClawBox AI run", () => {
    expect(harnessStateDir("clawbox-ai")).toBe(path.join(home, ".claude-ds"));
  });

  it("moves with CLAUDE_DS_CONFIG_DIR for ClawBox AI only — the wrapper's Anthropic branch ignores it", () => {
    const override = path.join(base, "elsewhere");
    process.env.CLAUDE_DS_CONFIG_DIR = override;
    expect(harnessStateDir("clawbox-ai")).toBe(override);
    expect(harnessStateDir("anthropic")).toBe(path.join(home, ".claude"));
  });

  it("does not follow an inherited CLAUDE_CONFIG_DIR, which the wrapper unsets or overwrites", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(base, "stray");
    expect(harnessStateDir("anthropic")).toBe(path.join(home, ".claude"));
    expect(harnessStateDir("clawbox-ai")).toBe(path.join(home, ".claude-ds"));
  });

  it("treats an empty CLAUDE_DS_CONFIG_DIR as unset, as ${VAR:-default} does", () => {
    process.env.CLAUDE_DS_CONFIG_DIR = "";
    expect(harnessStateDir("clawbox-ai")).toBe(path.join(home, ".claude-ds"));
  });
});

describe("a run's transcript", () => {
  it("is under ~/.claude for an Anthropic run, even before the file exists", () => {
    const run = { sessionId: SESSION, directory: directory(), provider: "anthropic" as const };
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude")));
    writeTranscript(fileUnder(path.join(home, ".claude")));
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude")));
  });

  it("is under ~/.claude-ds for a ClawBox AI run", () => {
    const run = { sessionId: SESSION, directory: directory(), provider: "clawbox-ai" as const };
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude-ds")));
    writeTranscript(fileUnder(path.join(home, ".claude-ds")));
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude-ds")));
  });

  it("follows CLAUDE_DS_CONFIG_DIR for a ClawBox AI run", () => {
    const override = path.join(base, "elsewhere");
    process.env.CLAUDE_DS_CONFIG_DIR = override;
    const run = { sessionId: SESSION, directory: directory(), provider: "clawbox-ai" as const };
    expect(transcriptPath(run)).toBe(fileUnder(override));
  });

  it("goes by the run's own provider, so each of two runs finds its own file", () => {
    writeTranscript(fileUnder(path.join(home, ".claude")));
    writeTranscript(fileUnder(path.join(home, ".claude-ds")));
    expect(transcriptPath({ sessionId: SESSION, directory: directory(), provider: "anthropic" }))
      .toBe(fileUnder(path.join(home, ".claude")));
    expect(transcriptPath({ sessionId: SESSION, directory: directory(), provider: "clawbox-ai" }))
      .toBe(fileUnder(path.join(home, ".claude-ds")));
  });

  it("falls back to ~/.claude when a ClawBox AI record's file is missing and only the other exists", () => {
    // A record whose provider was never written reads as ClawBox AI, the default.
    writeTranscript(fileUnder(path.join(home, ".claude")));
    const run = { sessionId: SESSION, directory: directory(), provider: "clawbox-ai" as const };
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude")));
  });

  it("falls back to ~/.claude-ds (or its override) when an Anthropic record's file is missing and only the other exists", () => {
    writeTranscript(fileUnder(path.join(home, ".claude-ds")));
    const run = { sessionId: SESSION, directory: directory(), provider: "anthropic" as const };
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude-ds")));

    const override = path.join(base, "elsewhere");
    process.env.CLAUDE_DS_CONFIG_DIR = override;
    writeTranscript(fileUnder(override));
    expect(transcriptPath(run)).toBe(fileUnder(override));
  });

  it("reads a record with no provider at all as the default, ClawBox AI", () => {
    const run = { sessionId: SESSION, directory: directory(), provider: undefined as unknown as "clawbox-ai" };
    expect(transcriptPath(run)).toBe(fileUnder(path.join(home, ".claude-ds")));
  });

  it("has nothing to offer until the run has a session, on either provider", () => {
    expect(transcriptPath({ sessionId: null, directory: directory(), provider: "anthropic" })).toBeNull();
    expect(transcriptPath({ sessionId: null, directory: directory(), provider: "clawbox-ai" })).toBeNull();
  });
});
