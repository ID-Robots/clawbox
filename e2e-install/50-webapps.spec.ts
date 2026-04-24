/**
 * Code assistant / webapps — exercise the "AI agent builds a desktop app"
 * flow end to end. The agent normally drives this via MCP tools, but each
 * MCP tool just wraps a setup-api/code endpoint, so we drive the same
 * endpoints directly here.
 *
 * Contract:
 *   1. init a project (scaffolds an `app` template with index.html)
 *   2. write a custom index.html with a distinctive string
 *   3. build → inlines CSS/JS into a single HTML, deploys to data/webapps
 *   4. fetch /setup-api/webapps?app=<id> and confirm our string is present
 *   5. clean up
 */
import { test, expect } from "@playwright/test";
import { dockerExec, BASE_URL } from "./helpers/container";
import {
  codeFileWrite,
  codeProjectBuild,
  codeProjectDelete,
  codeProjectInit,
  codeProjectList,
} from "./helpers/setup-api";

const PROJECT_ID = "e2e-webapp";
const MARKER = `E2E_MARKER_${Date.now()}`;

test.describe.configure({ mode: "serial" });

test.describe("code assistant → webapp build", () => {
  test.beforeAll(async () => {
    // Project IDs must be unique per-init. If a previous run left debris,
    // clean it up first.
    await codeProjectDelete(PROJECT_ID).catch(() => {});
  });

  test.afterAll(async () => {
    await codeProjectDelete(PROJECT_ID).catch(() => {});
  });

  test("init scaffolds a project on disk", async () => {
    const result = await codeProjectInit(PROJECT_ID, "E2E Webapp");
    expect(result.success).toBe(true);
    expect(result.project.id ?? (result.project as unknown as { projectId?: string }).projectId).toBe(PROJECT_ID);

    const listed = await codeProjectList();
    expect(listed.projects.some((p) => (p.id ?? (p as unknown as { projectId?: string }).projectId) === PROJECT_ID)).toBe(true);

    // Verify directory + scaffold files exist.
    const diskListing = await dockerExec(
      ["ls", `/home/clawbox/clawbox/data/code-projects/${PROJECT_ID}`],
      { user: "clawbox" },
    );
    expect(diskListing).toContain("index.html");
  });

  test("write custom index.html with marker string", async () => {
    const html = `<!DOCTYPE html><html><head><title>E2E</title></head><body><h1>${MARKER}</h1></body></html>`;
    const result = await codeFileWrite(PROJECT_ID, "index.html", html);
    expect(result.success).toBe(true);
  });

  test("build deploys to /data/webapps", async () => {
    const result = await codeProjectBuild(PROJECT_ID);
    expect(result.success).toBe(true);
    // result.url looks like /setup-api/webapps?app=<id>
    expect(result.url).toContain(PROJECT_ID);
  });

  test("built webapp is served at /setup-api/webapps", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/webapps?app=${PROJECT_ID}`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain(MARKER);
  });

  test("webapp file exists on disk at data/webapps", async () => {
    const listing = await dockerExec(
      ["ls", `/home/clawbox/clawbox/data/webapps/${PROJECT_ID}`],
      { user: "clawbox" },
    );
    expect(listing).toContain("index.html");
  });
});
