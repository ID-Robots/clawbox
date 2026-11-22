/**
 * A project's Folders on its page (src/components/CodingProjectFoldersCard.tsx,
 * TASK-2757): its own folder alone until another is added, "Add folder" offers
 * the owner's other project folders, × takes one off — each change saved
 * through the project-folders route and the list redrawn from its answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CodingProjectFoldersCard from "@/components/CodingProjectFoldersCard";

// One `t` for every render, as the provider gives: a new one each time would re-run the card's load.
const t = (key: string) => key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let stored: { folder: string; base?: string }[];
let calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>;
let refuse: string | null;

beforeEach(() => {
  stored = [];
  calls = [];
  refuse = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    if (!url.startsWith("/setup-api/coding-agent/project-folders")) return json({ error: "unexpected" }, 404);
    if (method === "POST" && refuse) return json({ error: refuse, kind: "not_a_repository" }, 400);
    if (method === "POST" && body?.action === "add") {
      if (stored.length === 0) stored = [{ folder: "gateway" }];
      stored = [...stored, { folder: String(body.folder) }];
    }
    if (method === "POST" && body?.action === "remove") {
      stored = stored.filter((f) => f.folder !== body.folder);
      if (stored.length === 1 && stored[0].folder === "gateway") stored = [];
    }
    return json({ project: "gateway", folders: stored });
  }));
});

describe("the Folders card", () => {
  it("shows a single-folder project as its own folder, with nothing to remove", async () => {
    render(<CodingProjectFoldersCard project="gateway" candidates={["dashboard", "docs"]} />);
    expect(await screen.findByTestId("coding-project-folder-gateway")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-project-folder-remove-gateway")).toBeNull();
    expect(calls[0]).toEqual({ method: "GET", url: "/setup-api/coding-agent/project-folders?project=gateway" });
  });

  it("adds a picked project folder, and removes it again", async () => {
    render(<CodingProjectFoldersCard project="gateway" candidates={["dashboard", "docs"]} />);
    fireEvent.click(await screen.findByTestId("coding-project-folders-add"));
    fireEvent.click(screen.getByTestId("coding-project-folders-pick-dashboard"));
    expect(await screen.findByTestId("coding-project-folder-dashboard")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ project: "gateway", action: "add", folder: "dashboard" });
    // Both are now removable, and the picker no longer offers what is listed.
    expect(screen.getByTestId("coding-project-folder-remove-gateway")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-project-folders-add"));
    expect(screen.queryByTestId("coding-project-folders-pick-dashboard")).toBeNull();
    expect(screen.getByTestId("coding-project-folders-pick-docs")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("coding-project-folder-remove-dashboard"));
    await waitFor(() => expect(screen.queryByTestId("coding-project-folder-dashboard")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ project: "gateway", action: "remove", folder: "dashboard" });
    expect(screen.queryByTestId("coding-project-folder-remove-gateway")).toBeNull();
  });

  it("says the route's own refusal", async () => {
    refuse = "notes is not a git repository directly inside the project folder.";
    render(<CodingProjectFoldersCard project="gateway" candidates={["notes"]} />);
    await waitFor(() => expect(screen.getByTestId("coding-project-folders-add")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("coding-project-folders-add"));
    fireEvent.click(screen.getByTestId("coding-project-folders-pick-notes"));
    expect(await screen.findByTestId("coding-project-folders-error")).toHaveTextContent("notes is not a git repository");
    expect(screen.queryByTestId("coding-project-folder-notes")).toBeNull();
  });
});
