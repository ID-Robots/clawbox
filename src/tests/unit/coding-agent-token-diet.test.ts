/**
 * TASK-1749, the coding agent's token diet: the defaults that decide how many
 * tokens an ordinary run spends, and the size and stability of the system
 * prompt every turn of every run carries.
 *
 * The appended system prompt is resent on every turn. Measured on a box, a job
 * an owner ran cost 20-30 million tokens where a single-agent tool spent about
 * 500k, so the prompt is held to a budget here, and it must be byte-identical
 * between runs with the same settings: anything per-run in it (an id, a time)
 * would break the provider's prefix cache and bill the prefix fresh each run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildRunArgs,
  DEFAULT_EFFORT,
  ULTRACODE_BRIEF,
  ULTRACODE_EFFORT,
} from "@/lib/coding-agent";
import { completionAttemptsFrom, DEFAULT_COMPLETION_ATTEMPTS, MAX_COMPLETION_ATTEMPTS } from "@/lib/coding-deliverable";
import { EXPERIENCE_BLOCK_MAX_CHARS } from "@/lib/coding-experience";
import { MAX_RUN_NOTES_CHARS, runNotesBlock } from "@/lib/coding-run-notes";

/** What a writing run's appended prompt may weigh with no run notes and no lessons. */
const BRIEF_BUDGET_CHARS = 10_000;
/** …and with every optional block at its own cap. */
const FULL_BUDGET_CHARS = 24_500;

function systemPrompt(args: string[]): string {
  return args[args.indexOf("--append-system-prompt") + 1];
}

const RUN = (id: string) => ({ id, directory: "/home/clawbox/Projects/site", media: { images: true, audio: true } });

describe("the token diet's defaults", () => {
  it("thinks at xhigh unless the owner chose otherwise — ultracode's fan-out is opt-in", () => {
    expect(DEFAULT_EFFORT).toBe("xhigh");
  });

  it("gives a run with a deliverable one attempt unless the owner asks for more", () => {
    expect(DEFAULT_COMPLETION_ATTEMPTS).toBe(1);
    expect(completionAttemptsFrom(undefined)).toBe(1);
    expect(completionAttemptsFrom(3)).toBe(3);
  });

  it("is what the code's own comment and the agent docs say the defaults are", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/coding-agent.ts"), "utf8");
    const key = source.indexOf("export const CODING_AGENT_COMPLETION_ATTEMPTS_CONFIG_KEY");
    const comment = source.slice(source.lastIndexOf("/**", key), key);
    const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
    const word = words[DEFAULT_COMPLETION_ATTEMPTS];
    expect(comment).toContain(`${word} by default`);
    expect(comment).not.toMatch(new RegExp(`\\b(${words.filter((w) => w !== word).join("|")}) by default`));
    // The ceiling counts the first turn too: "six in all", never six more.
    expect(comment).toContain(`${words[MAX_COMPLETION_ATTEMPTS].toLowerCase()} in all`);

    const doc = readFileSync(path.join(process.cwd(), "docs/agents/coding-agent.md"), "utf8");
    expect(doc).toContain(`the default is \`${DEFAULT_EFFORT}\``);
    expect(doc).not.toMatch(/ultracode[^.]*\bthe default\)/);
  });
});

describe("the appended system prompt", () => {
  it("stays inside its budget for an ordinary writing run", () => {
    const args = buildRunArgs({ effort: DEFAULT_EFFORT, provider: "clawbox-ai", run: RUN("run-aaaaaaaa"), cpuBudget: 2, lessonChannel: true, reviewedSeparately: false });
    expect(systemPrompt(args).length).toBeLessThanOrEqual(BRIEF_BUDGET_CHARS);
  });

  it("stays inside its budget with the PR brief, the ultracode brief, full run notes and a full experience block", () => {
    const args = buildRunArgs({
      effort: ULTRACODE_EFFORT,
      provider: "clawbox-ai",
      run: RUN("run-aaaaaaaa"),
      cpuBudget: 2,
      lessonChannel: true,
      draftPullRequests: true,
      runNotes: runNotesBlock("n".repeat(MAX_RUN_NOTES_CHARS)) ?? undefined,
      experience: "e".repeat(EXPERIENCE_BLOCK_MAX_CHARS),
    });
    const prompt = systemPrompt(args);
    expect(prompt).toContain(ULTRACODE_BRIEF);
    expect(prompt.length).toBeLessThanOrEqual(FULL_BUDGET_CHARS);
  });

  it("carries the ultracode brief only when ultracode was chosen", () => {
    expect(systemPrompt(buildRunArgs({ effort: DEFAULT_EFFORT, run: RUN("run-aaaaaaaa") }))).not.toContain(ULTRACODE_BRIEF);
  });

  it("is byte-identical for two runs with the same settings, so the provider's prefix cache holds across runs", () => {
    const a = buildRunArgs({ effort: DEFAULT_EFFORT, provider: "clawbox-ai", run: RUN("run-aaaaaaaa"), cpuBudget: 2, lessonChannel: true });
    const b = buildRunArgs({ effort: DEFAULT_EFFORT, provider: "clawbox-ai", run: RUN("run-bbbbbbbb"), cpuBudget: 2, lessonChannel: true });
    expect(systemPrompt(a)).toBe(systemPrompt(b));
    expect(systemPrompt(a)).not.toContain("run-aaaaaaaa");
    expect(a[a.indexOf("--agents") + 1]).toBe(b[b.indexOf("--agents") + 1]);
  });
});
