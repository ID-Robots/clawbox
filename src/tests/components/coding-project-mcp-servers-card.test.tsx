/**
 * A project's MCP servers on its page (src/components/CodingProjectMcpServersCard.tsx):
 * the harness's configured servers and "ClawBox read-only tools", every box
 * unticked until the owner ticks it, saved through the owner-only route — in
 * the real English strings, so a missing key fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingProjectMcpServersCard from "@/components/CodingProjectMcpServersCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OPTIONS = [
  { id: "clawbox", kind: "clawbox", usable: true },
  { id: "board", kind: "harness", harness: "openclaw", transport: "stdio", usable: true },
  { id: "docs", kind: "harness", harness: "openclaw", transport: "http", usable: false, reason: "it signs in through the harness (OAuth)" },
];

let selected: string[];
let calls: Array<{ method: string; url: string; body?: unknown }>;
let refusePost: string | null;

beforeEach(() => {
  selected = [];
  refusePost = null;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (!url.startsWith("/setup-api/coding-agent/mcp-servers")) return json({ error: "unexpected" }, 404);
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "POST") {
      if (refusePost) return json({ error: refusePost, code: "store_unreadable" }, 500);
      selected = (JSON.parse(String(init!.body)) as { servers: string[] }).servers;
    }
    return json({ project: "site", selected, options: OPTIONS, unreadable: [], clawboxMcpEnabled: true, max: 32 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the MCP servers card", () => {
  it("lists every server unticked, and says the project runs with browser tools only", async () => {
    render(<CodingProjectMcpServersCard project="site" />);
    const board = await screen.findByTestId("coding-project-mcp-server-board");
    expect(board).not.toBeChecked();
    expect(screen.getByTestId("coding-project-mcp-server-clawbox")).not.toBeChecked();
    expect(screen.getByText(t("codingAgent.mcpServers.clawboxReadOnly"))).toBeInTheDocument();
    expect(screen.getByTestId("coding-project-mcp-servers-count")).toHaveTextContent(t("codingAgent.mcpServers.none"));
    // A server a run cannot start is shown, greyed, with the reason.
    expect(screen.getByTestId("coding-project-mcp-server-docs")).toBeDisabled();
    expect(screen.getByText(t("codingAgent.mcpServers.unusable", { reason: "it signs in through the harness (OAuth)" }))).toBeInTheDocument();
    expect(calls[0]).toEqual({ method: "GET", url: "/setup-api/coding-agent/mcp-servers?project=site" });
  });

  it("saves a tick and an untick as the project's whole list", async () => {
    render(<CodingProjectMcpServersCard project="site" />);
    fireEvent.click(await screen.findByTestId("coding-project-mcp-server-board"));
    await waitFor(() => expect(screen.getByTestId("coding-project-mcp-server-board")).toBeChecked());
    expect(calls.at(-1)).toEqual({ method: "POST", url: "/setup-api/coding-agent/mcp-servers", body: { project: "site", servers: ["board"] } });
    expect(screen.getByTestId("coding-project-mcp-servers-count")).toHaveTextContent(t("codingAgent.mcpServers.count", { n: 1 }));

    fireEvent.click(screen.getByTestId("coding-project-mcp-server-board"));
    await waitFor(() => expect(screen.getByTestId("coding-project-mcp-server-board")).not.toBeChecked());
    expect(calls.at(-1)?.body).toEqual({ project: "site", servers: [] });
  });

  it("says why a save failed and keeps what was there", async () => {
    refusePost = "This ClawBox could not read its settings file, so nothing was changed.";
    render(<CodingProjectMcpServersCard project="site" />);
    fireEvent.click(await screen.findByTestId("coding-project-mcp-server-clawbox"));
    expect(await screen.findByTestId("coding-project-mcp-servers-error")).toHaveTextContent(refusePost);
    expect(screen.getByTestId("coding-project-mcp-server-clawbox")).not.toBeChecked();
  });

  it("renders nothing for a folder that is no project scope", () => {
    const { container } = render(<CodingProjectMcpServersCard project="has space" />);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });
});
