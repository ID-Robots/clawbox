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
  // The box's English floor differs from the catalogue's wording on purpose,
  // so the test can tell which one the card printed.
  { id: "docs", kind: "harness", harness: "openclaw", transport: "http", usable: false, reason: "OAuth sign-in", reasonCode: "oauth" },
];

let selected: string[];
let calls: Array<{ method: string; url: string; body?: unknown }>;
let refusePost: string | null;
let failGets: number;

beforeEach(() => {
  selected = [];
  refusePost = null;
  failGets = 0;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (!url.startsWith("/setup-api/coding-agent/mcp-servers")) return json({ error: "unexpected" }, 404);
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET" && failGets > 0) {
      failGets--;
      return json({ error: "boom" }, 500);
    }
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
    // Worded from the reason's CODE in the owner's language, not the box's English sentence.
    expect(screen.getByText(t("codingAgent.mcpServers.unusable", { reason: t("codingAgent.mcpServers.reason.oauth") }))).toBeInTheDocument();
    expect(screen.queryByText(/OAuth sign-in/)).toBeNull();
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

  it("says a failed read and offers to read it again", async () => {
    failGets = 1;
    render(<CodingProjectMcpServersCard project="site" />);
    const retry = await screen.findByTestId("coding-project-mcp-servers-retry");
    expect(screen.getByTestId("coding-project-mcp-servers-count")).toHaveTextContent(t("codingAgent.mcpServers.loadFailed"));
    fireEvent.click(retry);
    expect(await screen.findByTestId("coding-project-mcp-server-board")).not.toBeChecked();
    expect(screen.queryByTestId("coding-project-mcp-servers-retry")).toBeNull();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("falls back to the box's own sentence for a reason it has no words for", async () => {
    OPTIONS.push({ id: "odd", kind: "harness", harness: "hermes", transport: "stdio", usable: false, reason: "a reason from a newer box", reasonCode: "from_the_future" });
    try {
      render(<CodingProjectMcpServersCard project="site" />);
      expect(await screen.findByText(t("codingAgent.mcpServers.unusable", { reason: "a reason from a newer box" }))).toBeInTheDocument();
    } finally {
      OPTIONS.pop();
    }
  });

  it("renders nothing for a signed-in user who is not the owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Only the owner of this ClawBox can choose a project's MCP servers.", code: "owner_only" }, 403)));
    const { container } = render(<CodingProjectMcpServersCard project="site" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByTestId("coding-project-mcp-servers-retry")).toBeNull();
  });

  it("renders nothing for a folder that is no project scope", () => {
    const { container } = render(<CodingProjectMcpServersCard project="has space" />);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });
});
