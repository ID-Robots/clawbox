/**
 * GET /setup-api/coding-agent/artifacts — one run artifact's bytes.
 *
 * Everything in that folder was written by the DELEGATED AGENT, so the two
 * properties pinned here are the ones that keep it from becoming a stored XSS
 * or a file-read gadget: only images are served with an image type — any
 * other file, HTML included, comes back text/plain with nosniff — and the
 * name/id gate answers 404 for anything that is not a plain file of that
 * run's own folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type ArtifactsLib = typeof import("@/lib/coding-agent-artifacts");

let GET: (req: Request) => Promise<Response>;
let artifacts: ArtifactsLib;
let base: string;
let root: string;
let restore: () => void;

const RUN_ID = "run-abc12345";
const url = (runId: string, file: string) =>
  new Request(`http://localhost/setup-api/coding-agent/artifacts?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}`);

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-route-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  artifacts = await import("@/lib/coding-agent-artifacts");
  GET = (await import("@/app/setup-api/coding-agent/artifacts/route")).GET;
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GET artifacts", () => {
  it("serves an image inline with its real type", async () => {
    const dir = artifacts.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(dir, "shot-001.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await GET(url(RUN_ID, "shot-001.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves agent-written HTML as plain text, never as a page in the app's origin", async () => {
    const dir = artifacts.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(dir, "page.html"), "<script>document.cookie</script>");
    const res = await GET(url(RUN_ID, "page.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("answers a JSON 404 for traversal names, dotfiles, unknown files and malformed run ids", async () => {
    artifacts.ensureArtifactsDir(RUN_ID);
    for (const [runId, file] of [
      [RUN_ID, "../config.json"],
      [RUN_ID, ".mcp-token"],
      [RUN_ID, "missing.png"],
      ["../../etc", "passwd"],
      ["run-!!", "shot-001.png"],
    ] as const) {
      const res = await GET(url(runId, file));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ kind: "not_found" });
    }
  });
});
