/**
 * What the Create planner adds to the prompts it hands the chat
 * (src/lib/ui-events.ts): a multi-line brief quoted as a block, the reference
 * pictures with how a run gets them, and the "plan first" sentence. A
 * one-line brief reads exactly as it did before the planner.
 */
import { describe, expect, it } from "vitest";
import { buildNewAppPrompt, buildResumeProjectPrompt, buildTeamProjectPrompt, PLAN_FIRST_SENTENCE, referencesLines } from "@/lib/ui-events";

const PROJECT = { name: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder" as const, folder: "shop" };

describe("the planner's prompts", () => {
  it("keeps a one-line brief as the end of the opening sentence", () => {
    expect(buildNewAppPrompt({ name: "Timer", description: "A pomodoro timer.", template: "app" }).split("\n")[0])
      .toBe('Create a new ClawBox app called "Timer": A pomodoro timer.');
  });

  it("quotes a multi-line brief as a block under the opening sentence", () => {
    const brief = "## Features\n- Customers\n- Invoices";
    const lines = buildNewAppPrompt({ name: "Shop", description: brief, template: "nextjs" }).split("\n");
    expect(lines[0]).toBe('Create a new ClawBox app called "Shop". The brief:');
    expect(lines.slice(2, 5).join("\n")).toBe(brief);
    expect(buildResumeProjectPrompt({ ...PROJECT, instructions: brief }).split("\n")[0]).toBe(`Continue the existing ClawBox project "shop" in ${PROJECT.directory}. The brief:`);
  });

  it("names the pictures and tells a run to take them as input_files, and a team to copy them in", () => {
    const paths = ["/m/a.png", "/m/b.png"];
    const solo = buildNewAppPrompt({ name: "Shop", description: "x", template: "nextjs" }, { references: paths });
    expect(solo).toContain("- [image 1] /m/a.png\n- [image 2] /m/b.png");
    expect(solo).toContain("input_files");
    const team = buildTeamProjectPrompt({ ...PROJECT, instructions: "x" }, { references: paths });
    expect(team).toContain("- [image 2] /m/b.png");
    expect(team).toContain('copy these pictures into a "design" folder in the project and commit them');
    expect(referencesLines([], "coding_agent_run")).toEqual([]);
  });

  it("ends with the plan-first sentence when asked, after the ultracode one", () => {
    const p = buildResumeProjectPrompt({ ...PROJECT, instructions: "x" }, { ultracode: true, planFirst: true });
    expect(p.endsWith(PLAN_FIRST_SENTENCE)).toBe(true);
    expect(p).toContain('effort "ultracode"');
    expect(buildNewAppPrompt({ name: "S", description: "x", template: "app" })).not.toContain(PLAN_FIRST_SENTENCE);
  });
});
