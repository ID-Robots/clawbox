/**
 * A run that may only read — a coding team's planner — gets the tools and
 * the brief that match: Read, Grep, Glob and the helpers, no Bash approval,
 * no browser tools, and words that never describe a shell. Nor anything a
 * shell-less run cannot use: the Workflow fan-out, the helpers that carry
 * Bash, the browser profile and the media allowance of its MCP server.
 */
import { describe, expect, it } from "vitest";
import { buildCodexRunArgs, buildRunArgs, READ_ONLY_BRIEF, READ_ONLY_TOOLS, SUBAGENT_DEFINITIONS, subagentDefinitionsFor, WORKFLOW_TOOL } from "@/lib/coding-agent";

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

  it("is never handed the Workflow tool, whatever effort the record carries", () => {
    // startRun clamps a read-only run's ultracode to xhigh; a record from
    // before that clamp still resumes with `effort: "ultracode"`, and must
    // not get the fan-out either.
    const args = buildRunArgs({ effort: "ultracode", readOnly: true, run: { id: "run-aaaaaaaa", directory: "/p" } });
    expect(flag(args, "--allowedTools")).not.toContain(WORKFLOW_TOOL);
    expect(flag(args, "--tools")[0].split(",")).not.toContain(WORKFLOW_TOOL);
    expect(args).not.toContain(WORKFLOW_TOOL);
  });

  it("gets no helper that carries Bash, and keeps the two no-Bash decoys", () => {
    for (const provider of ["clawbox-ai", "anthropic"] as const) {
      const defs = subagentDefinitionsFor(provider, { readOnly: true });
      expect(Object.keys(defs).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer"]);
      for (const def of Object.values(defs) as { tools: string[] }[]) expect(def.tools).not.toContain("Bash");
      // A writing run keeps every definition, the tester among them.
      expect(Object.keys(subagentDefinitionsFor(provider))).toEqual(Object.keys(SUBAGENT_DEFINITIONS));
    }
    const args = buildRunArgs({ readOnly: true, run: { id: "run-aaaaaaaa", directory: "/p" } });
    const handed = JSON.parse(flag(args, "--agents")[0]) as Record<string, unknown>;
    expect(Object.keys(handed).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer"]);
  });

  it("starts no browser profile and holds no media on its MCP server, on either harness", () => {
    const run = { id: "run-aaaaaaaa", directory: "/p", media: { images: true, audio: true }, team: { id: "team-aaaaaaaa", role: "planner" as const, taskId: null } };
    const claude = JSON.parse(flag(buildRunArgs({ readOnly: true, visual: true, run }), "--mcp-config")[0]) as { mcpServers: { clawbox: { env: Record<string, string> } } };
    expect(claude.mcpServers.clawbox.env.CLAWBOX_RUN_BROWSER).toBe("0");
    expect(claude.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBeUndefined();
    expect(claude.mcpServers.clawbox.env.CLAWBOX_TEAM_ROLE).toBe("planner");
    const codex = buildCodexRunArgs({ readOnly: true, visual: true, run, model: "gpt-5.6-luna" }).join("\n");
    expect(codex).toContain('CLAWBOX_RUN_BROWSER = "0"');
    expect(codex).not.toContain("CLAWBOX_RUN_MEDIA");
    // A writing run on the same record keeps its browser and media.
    const writer = JSON.parse(flag(buildRunArgs({ visual: true, run: { ...run, team: { ...run.team, role: "worker" as const, taskId: "t1" } } }), "--mcp-config")[0]) as { mcpServers: { clawbox: { env: Record<string, string> } } };
    expect(writer.mcpServers.clawbox.env.CLAWBOX_RUN_BROWSER).toBeUndefined();
    expect(writer.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBeTruthy();
  });

  it("is told how many steps it has, and that a step is one reply", () => {
    const brief = flag(buildRunArgs({ readOnly: true, maxTurns: 100 }), "--append-system-prompt")[0];
    expect(brief).toContain("This run has 100 steps.");
    expect(READ_ONLY_BRIEF).toContain("each reply you send spends one step, however many tool calls it carries");
    expect(READ_ONLY_BRIEF).not.toContain("every tool call spends one");
    // The constant itself never carries a figure: it is compared byte for byte.
    expect(READ_ONLY_BRIEF).not.toContain("This run has");
    expect(flag(buildRunArgs({ readOnly: true }), "--append-system-prompt")[0]).not.toContain("This run has");
  });

  it("leaves an ordinary run exactly as it was", () => {
    const args = buildRunArgs({ effort: "ultracode", run: { id: "run-aaaaaaaa", directory: "/p", media: { images: false, audio: false } } });
    expect(flag(args, "--tools")[0]).toContain("Bash");
    expect(flag(args, "--allowedTools")).toContain("Bash(*)");
    expect(flag(args, "--append-system-prompt")[0]).not.toContain(READ_ONLY_BRIEF);
  });
});
