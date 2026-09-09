import { expect, it, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { once } from "events";
import { ownsLocalPreview } from "@/lib/coding-local-preview";
// Real listener/process ownership, not a mock of the access decision.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
it.each(["127.0.0.1", "::1"])("allows only a live run's own %s listener in its project and process group", async (host) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "preview-owner-"));
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "preview-other-"));
  const child = spawn(process.execPath, ["-e", `const s=require('http').createServer((q,r)=>r.end('preview'));s.listen(0,'${host}',()=>console.log(s.address().port));`], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [chunk] = await once(child.stdout!, "data");
    const port = Number(String(chunk).trim());
    const url = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}/`);
    const run = { directory: cwd, pgid: child.pid!, status: "running" };
    expect(await ownsLocalPreview(url, run)).toBe(true);
    expect(await ownsLocalPreview(url, { ...run, pgid: process.pid })).toBe(false);
    expect(await ownsLocalPreview(url, { ...run, directory: otherProject })).toBe(false);
    expect(await ownsLocalPreview(url, { ...run, directory: cwd + '-other' })).toBe(false);
    expect(await ownsLocalPreview(url, { ...run, status: "completed" })).toBe(false);
    for (const target of ["http://127.0.0.1:80/", "http://192.168.50.1:3000/", "http://169.254.169.254/", `http://name.localhost:${port}/`, `http://user:pass@127.0.0.1:${port}/`]) {
      expect(await ownsLocalPreview(new URL(target), run)).toBe(false);
    }
    child.kill();
    await once(child, "exit");
    expect(await ownsLocalPreview(url, run)).toBe(false);
  } finally {
    child.kill();
    fs.rmSync(otherProject, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
