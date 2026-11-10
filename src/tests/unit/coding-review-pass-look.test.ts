/**
 * The review pass is TOLD to look (src/lib/coding-agent.ts).
 *
 * `coding_agent_real_browser` only ever decided WHICH Chromium answers — the
 * owner's screen or an invisible one — and nothing in REVIEW_PASS_TASK asked
 * anyone to open a page at all, so interface work could be reviewed by a pass
 * that had read the diff and seen nothing. What is pinned here is the join:
 * the fixed review text still stands, the visual half is decided by the DEVICE
 * from the files the run touched, and the preview script the brief names is
 * the one the environment points at.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

import fs from "fs";
import { buildRunEnv, buildRunSystemPrompt, previewScriptPath, reviewPassTask, REVIEW_PASS_TASK, HEADLESS_BRIEF, worktreeCopyBrief } from "@/lib/coding-agent";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("the task a review pass is given", () => {
  it("keeps the review text it always had", () => {
    const task = reviewPassTask({ filesTouched: ["src/components/Card.tsx"] });
    expect(task.startsWith(REVIEW_PASS_TASK)).toBe(true);
    expect(task).toContain("running the project's own verification");
    expect(task).toContain("Report only what you ran in this pass");
  });

  it("adds the visual check when the run touched the interface", () => {
    const task = reviewPassTask({ filesTouched: ["src/lib/store.ts", "src/components/Card.tsx"] });
    expect(task).toContain("VISUAL CHECK — this diff touches the interface");
    expect(task).toContain("Card.tsx");
    expect(task).toContain("$CLAWBOX_PREVIEW");
  });

  it("adds the explicit skip when it did not, so the pass never just goes quiet", () => {
    const task = reviewPassTask({ filesTouched: ["src/lib/store.ts", "package.json"] });
    expect(task).toContain("VISUAL CHECK: none is needed");
    expect(task).not.toContain("PREVIEW_URL");
  });
});

describe("the preview script the brief names", () => {
  it("is in the environment every run gets, under a name a secret cannot take", async () => {
    const env = buildRunEnv({});
    expect(env.CLAWBOX_PREVIEW).toBe(previewScriptPath());
    // CLAWBOX_ is a reserved prefix, so the owner's secret store cannot point a
    // run's preview somewhere else (project-secrets-shape.ts).
    const { isReservedSecretName } = await import("@/lib/project-secrets-shape");
    expect(isReservedSecretName("CLAWBOX_PREVIEW")).toBe(true);
    expect(buildRunEnv({ secrets: { CLAWBOX_PREVIEW: "/tmp/evil.mjs" } }).CLAWBOX_PREVIEW).toBe(previewScriptPath());
  });

  it("exists on disk where the brief says it does", () => {
    const relative = previewScriptPath().split("/").slice(-2).join("/");
    expect(relative).toBe("scripts/clawbox-preview.mjs");
    expect(fs.existsSync("scripts/clawbox-preview.mjs")).toBe(true);
  });

  it("is offered to an ordinary run too, in the brief's own live-verification clause", () => {
    expect(HEADLESS_BRIEF).toContain("$CLAWBOX_PREVIEW");
    expect(HEADLESS_BRIEF).toContain("PREVIEW_URL");
  });
});

describe("what a run in its own copy of a project is told about the copy", () => {
  const copy = "/home/clawbox/Projects/calculator/.clawbox/worktrees/run-w263ek7z";
  const run = (directory: string, over: Record<string, unknown> = {}) => ({ id: "run-w263ek7z", directory, ...over });

  it("says the app's id is set and the packages are real, and that older notes saying otherwise are out of date", () => {
    // run-w263ek7z (2026-11-10): CLAWBOX_APP_ID was already in its environment,
    // and its project's notes — written before the variable existed — said to
    // run the gates from a copy in a folder named like the app. It believed
    // the notes, made a throwaway copy, and left the screenshots it refreshed there.
    const said = buildRunSystemPrompt({ run: run(copy) } as Parameters<typeof buildRunSystemPrompt>[0]);
    expect(said).toContain(worktreeCopyBrief("calculator"));
    expect(worktreeCopyBrief("calculator")).toMatch(/CLAWBOX_APP_ID=calculator is set/);
    expect(worktreeCopyBrief("calculator")).toMatch(/mounts at \/apps\/calculator\/ here/);
    expect(worktreeCopyBrief("calculator")).toMatch(/build and run the project's checks in THIS folder/);
    expect(worktreeCopyBrief("calculator")).toMatch(/copy the project elsewhere, rename the folder or install again first is out of date/);
  });

  it("is said to no run that is not in such a copy, reads only, or is a team's", () => {
    const of = (opts: Record<string, unknown>) => buildRunSystemPrompt(opts as Parameters<typeof buildRunSystemPrompt>[0]);
    expect(of({ run: run("/home/clawbox/Projects/calculator") })).not.toMatch(/temporary copy of the project/);
    expect(of({ run: run(copy), readOnly: true })).not.toMatch(/temporary copy of the project/);
    // A team's worker is told about its folder in its own brief (workerTask), and gets no node_modules.
    expect(of({ run: run(copy, { team: { id: "team-abcd1234", role: "worker", taskId: "t1" } }) })).not.toMatch(/temporary copy of the project/);
    expect(of({})).not.toMatch(/temporary copy of the project/);
  });
});
