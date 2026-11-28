// `email_draft_card` — the assistant's one tool for a draft it prepared.
//
// It must (a) be offered on both editions, (b) hand back the exact line the
// chat turns into a card, (c) say "cards are off" as a stop-and-tell answer, and
// above all (d) be unable to send: it reads a status route and nothing else, and
// no tool anywhere in the MCP server names the approval routes.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../mcp/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../mcp/lib/api")>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../../../mcp/lib/api";
import { ApiError } from "../../../mcp/lib/errors";
import { registerEmailTools } from "../../../mcp/tools/email";
import { captureRegistrar } from "../helpers/mcp-registrar";

function harness(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerEmailTools(h.reg, { emailCanRead: false });
  return h;
}

afterEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
});

describe("email_draft_card", () => {
  it("is offered on both editions, read-only, with one parameter", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const tool = harness(edition).get("email_draft_card");
      expect(tool.opts.readOnly).toBe(true);
      expect(Object.keys(tool.shape)).toEqual(["draft_id"]);
    }
  });

  it("hands back the line for the chat, and says it cannot send", async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true, draft: "found" });
    const out = await harness().call("email_draft_card", { draft_id: " AAMk-1= " });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const body = JSON.parse(out.text);
    expect(body).toMatchObject({ card: true, sent: false, line: "EMAIL_DRAFT:AAMk-1=" });
    expect(body.show_the_person_the_draft).toContain("`EMAIL_DRAFT:AAMk-1=`");
    expect(body.show_the_person_the_draft).toContain("You CANNOT send it");
    expect(apiGet).toHaveBeenCalledWith("/setup-api/email/draft-approval/status?draft=AAMk-1%3D");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("tells the agent to stop and tell the person when cards are off", async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: false });
    const out = await harness().call("email_draft_card", { draft_id: "d1" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const body = JSON.parse(out.text);
    expect(body).toMatchObject({ card: false, sent: false });
    expect(body.line).toBeUndefined();
    expect(body.what_to_do).toContain("Drafts folder");
  });

  it("refuses an id the mailbox does not have, and one that is not an id", async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true, draft: "missing" });
    const missing = await harness().call("email_draft_card", { draft_id: "nope" });
    expect(missing.isError && missing.error.code).toBe("NOT_FOUND");

    const bad = await harness().call("email_draft_card", { draft_id: "two words" });
    expect(bad.isError && bad.error.code).toBe("BAD_ARGUMENT");

    vi.mocked(apiGet).mockRejectedValue(new ApiError(400, "{}"));
    const refused = await harness().call("email_draft_card", { draft_id: "x" });
    expect(refused.isError && refused.error.code).toBe("BAD_ARGUMENT");
  });

  it("still gives the line when the mail service could not confirm the draft", async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true, draft: "unknown" });
    const out = await harness().call("email_draft_card", { draft_id: "d1" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(JSON.parse(out.text)).toMatchObject({ card: true, line: "EMAIL_DRAFT:d1" });
  });
});

describe("no tool can approve or send a draft", () => {
  it("no MCP source names the card or decide routes", () => {
    const root = path.resolve(__dirname, "../../../mcp");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|mjs|cjs|json|sh)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/draft-approval\/(card|decide)\b/.test(text)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
