/**
 * Memory Shard's first-run wizard.
 *
 * The properties worth pinning are the ones that were wrong before it existed:
 * the feature is OFF until the owner finishes setup, the completion flag is
 * written only at the very end (an earlier one would swap the last step for the
 * home page mid-wizard, which is the exact bug the coding agent's wizard hit),
 * and the provisioning step ENABLES Ollama rather than merely starting it —
 * OpenClaw's memory search connects to 127.0.0.1:11434 directly, so a box that
 * only started it would index once and fail every scheduled pass after the
 * ten-minute idle stop.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import MemoryShardWizard from "@/components/MemoryShardWizard";

let posts: { url: string; body: unknown }[] = [];

function stub(opts: { modelPresent?: boolean } = {}) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (url.startsWith("/setup-api/clawkeep/memory/sources")) {
      if (init?.method) posts.push({ url: "/setup-api/clawkeep/memory/sources", body: JSON.parse(String(init.body)) });
      return json({ paths: [] });
    }
    if (url.startsWith("/setup-api/coding-agent/browse")) {
      return json({ root: "/home/clawbox", path: "/home/clawbox", parent: null, entries: [{ name: "Documents", path: "/home/clawbox/Documents" }] });
    }
    if (url.startsWith("/setup-api/ollama/status")) {
      return json({ running: false, models: opts.modelPresent ? [{ name: "qwen3-embedding:0.6b" }] : [] });
    }
    if (url === "/setup-api/local-models" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ ok: true });
    }
    if (url === "/setup-api/ollama/pull" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      // Ollama's own NDJSON, byte counts and all.
      const body = '{"status":"pulling","completed":50,"total":100}\n{"status":"success","completed":100,"total":100}\n';
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (init?.method) posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return json({ ok: true });
  }));
}

beforeEach(() => stub());
afterEach(() => vi.unstubAllGlobals());

describe("MemoryShardWizard", () => {
  it("opens on the intro, with nothing switched on yet", async () => {
    render(<MemoryShardWizard onDone={() => {}} />);
    expect(await screen.findByTestId("memory-shard-enable")).toBeInTheDocument();
    expect(posts.filter((p) => p.url.endsWith("/enable"))).toEqual([]);
  });

  it("walks intro -> folders -> schedule -> provision", async () => {
    render(<MemoryShardWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId("memory-shard-enable"));
    expect(screen.getByTestId("memory-shard-browse")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    expect(screen.getByTestId("memory-shard-time")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    expect(screen.getByTestId("memory-shard-index-now")).toBeInTheDocument();
  });

  it("adds a folder through the picker", async () => {
    render(<MemoryShardWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId("memory-shard-enable"));
    fireEvent.click(screen.getByTestId("memory-shard-browse"));
    fireEvent.click(await screen.findByTestId("memory-shard-pick"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/sources"))).toBe(true));
  });

  it("ENABLES ollama, pulls the model, points the index at it, and only then marks setup done", async () => {
    const done = vi.fn();
    render(<MemoryShardWizard onDone={done} />);
    fireEvent.click(await screen.findByTestId("memory-shard-enable"));
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));

    await waitFor(() => expect(done).toHaveBeenCalled());

    const localModels = posts.find((p) => p.url === "/setup-api/local-models");
    // enabled:true, not a bare start — see the file header.
    expect(localModels?.body).toEqual({ id: "ollama", enabled: true });
    expect(posts.find((p) => p.url === "/setup-api/ollama/pull")?.body).toEqual({ model: "qwen3-embedding:0.6b" });

    const order = posts.map((p) => p.url);
    expect(order.indexOf("/setup-api/clawkeep/memory/provider")).toBeGreaterThan(order.indexOf("/setup-api/ollama/pull"));
    // The completion flag is LAST, with the switch, after everything that can fail.
    const enable = posts.find((p) => p.url === "/setup-api/clawkeep/memory/enable");
    expect(enable?.body).toEqual({ enabled: true, setupComplete: true });
    expect(order.indexOf("/setup-api/clawkeep/memory/index"))
      .toBeGreaterThan(order.indexOf("/setup-api/clawkeep/memory/enable"));
  });

  it("skips the download when the model is already on the box", async () => {
    stub({ modelPresent: true });
    render(<MemoryShardWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId("memory-shard-enable"));
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));
    await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/clawkeep/memory/enable")).toBe(true));
    expect(posts.find((p) => p.url === "/setup-api/ollama/pull")).toBeUndefined();
  });
});
