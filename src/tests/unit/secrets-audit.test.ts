/**
 * The secret store's audit trail (src/lib/secrets-audit.ts): what a line may
 * hold, the bound on the file, and that a failed write never fails the change
 * it records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

let root = "";
let restoreEnv: () => void;
let audit: typeof import("@/lib/secrets-audit");

function logPath(): string {
  return path.join(root, "data", "secrets-audit.log");
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-secrets-audit-")));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  audit = await import("@/lib/secrets-audit");
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a line", () => {
  it("holds the time, the action and the re-checked labels — and has nowhere a value could go", () => {
    const line = JSON.parse(audit.auditLine(
      { action: "import", name: "GITHUB_TOKEN", scope: "@box", source: "hermes" },
      new Date("2026-10-21T00:00:00Z"),
    ));
    expect(line).toEqual({ at: "2026-10-21T00:00:00.000Z", action: "import", name: "GITHUB_TOKEN", scope: "@box", source: "hermes" });
  });

  it("drops a field that is not what its label says, rather than writing it", () => {
    const smuggled = {
      action: "save",
      name: "not a name: sk-live-0000",
      names: ["OK_NAME", "also not\\na name"],
      scope: "../../etc",
      runId: "run 1; rm -rf /",
      reason: "Some Reason With Value sk-live-0000",
      value: "sk-live-0000",
    } as unknown as Parameters<typeof audit.auditLine>[0];
    const text = audit.auditLine(smuggled);
    expect(text).not.toContain("sk-live-0000");
    expect(JSON.parse(text)).toEqual({ at: expect.any(String), action: "save", names: ["OK_NAME"] });
  });
});

describe("the file", () => {
  it("is created 0600 and appended one line per event, in order", async () => {
    await audit.appendSecretAudit({ action: "save", name: "A_TOKEN", scope: "@box" });
    await audit.appendSecretAudit({ action: "delete", name: "A_TOKEN", scope: "@box" });
    const lines = fs.readFileSync(logPath(), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(["save", "delete"]);
    expect((fs.statSync(logPath()).mode & 0o777).toString(8)).toBe("600");
  });

  it("keeps the newest half, on whole lines, once it outgrows its bound", async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const old = `${JSON.stringify({ at: "2020-01-01T00:00:00.000Z", action: "save", name: "OLD_TOKEN", scope: "@box" })}\n`;
    fs.writeFileSync(logPath(), old.repeat(Math.ceil(audit.MAX_AUDIT_BYTES / old.length) + 10), { mode: 0o600 });
    await audit.appendSecretAudit({ action: "save", name: "NEW_TOKEN", scope: "@box" });
    const text = fs.readFileSync(logPath(), "utf-8");
    expect(text.length).toBeLessThanOrEqual(audit.MAX_AUDIT_BYTES / 2 + old.length);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ name: "NEW_TOKEN" });
    expect((fs.statSync(logPath()).mode & 0o777).toString(8)).toBe("600");
  });

  it("never throws: a trail it cannot write is reported, and the caller carries on", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // data/ is a FILE, so nothing can be created under it.
    fs.writeFileSync(path.join(root, "data"), "not a directory");
    await expect(audit.appendSecretAudit({ action: "save", name: "A_TOKEN", scope: "@box" })).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });
});
