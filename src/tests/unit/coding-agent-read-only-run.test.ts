/**
 * A run that may only read — a coding team's planner — gets the tools and
 * the brief that match: Read, Grep, Glob and the helpers, no Bash approval,
 * no browser tools, and words that never describe a shell.
 */
import { describe, expect, it } from "vitest";
import { buildRunArgs, READ_ONLY_BRIEF, READ_ONLY_TOOLS } from "@/lib/coding-agent";

function flag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  }
  return out;
}

describe("a read-only run", () => {
  it("lists only the reading tools, approves no Bash, and carries the read-only brief plus the role's words", () => {
    const args = buildRunArgs({ effort: "ultracode", readOnly: true, extraBrief: "Answer with ONLY a JSON array.", run: { id: "run-aaaaaaaa", directory: "/p", media: { images: true, audio: true } } });
    expect(flag(args, "--tools")).toEqual([READ_ONLY_TOOLS]);
    expect(READ_ONLY_TOOLS).toBe("Read,Grep,Glob,Agent");
    const allowed = flag(args, "--allowedTools");
    expect(allowed).not.toContain("Bash(*)");
    expect(allowed.some((a) => a.startsWith("mcp__"))).toBe(false);
    const brief = flag(args, "--append-system-prompt")[0];
    expect(brief).toContain(READ_ONLY_BRIEF);
    expect(brief).toContain("Answer with ONLY a JSON array.");
    expect(brief).not.toMatch(/ONE command per Bash call|browser_view_local|CLAWBOX_RUN_ARTIFACTS_DIR|generate_image/);
    expect(READ_ONLY_BRIEF).toMatch(/READ-ONLY session/);
  });

  it("leaves an ordinary run exactly as it was", () => {
    const args = buildRunArgs({ effort: "ultracode", run: { id: "run-aaaaaaaa", directory: "/p", media: { images: false, audio: false } } });
    expect(flag(args, "--tools")[0]).toContain("Bash");
    expect(flag(args, "--allowedTools")).toContain("Bash(*)");
    expect(flag(args, "--append-system-prompt")[0]).not.toContain(READ_ONLY_BRIEF);
  });
});
