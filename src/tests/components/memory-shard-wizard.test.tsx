/**
 * Memory Shard's first-run wizard.
 *
 * The properties worth pinning are the ones that were wrong before it existed:
 * the feature is OFF until the owner finishes setup, the completion flag is
 * written only at the very end (an earlier one would swap the last step for the
 * home page mid-wizard, which is the exact bug the coding agent's wizard hit),
 * and the provisioning step fetches the model as a ROOT STEP and then points
 * the index at the embedder behind the local-AI proxy — it never enables or
 * starts an engine itself, because the proxy wakes the embedder on every
 * search (the ollama-era wizard had to enable a daemon permanently, since a
 * search reached it directly and could not wake it).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import MemoryShardWizard from "@/components/MemoryShardWizard";
import { clawkeepTranslations } from "@/lib/clawkeep-translations";

// Rendered without an I18nProvider, `t` answers the key itself — which is
// what these tests match on. The translation table is imported only to prove
// the key the wizard shows is one that has words behind it.
const START_FAILED = "clawkeep.memory.startFailed";
const PULL_FAILED = "clawkeep.memory.setup.pullFailed";

// The signal rides along so a test can ask, after the fact, whether the wizard
// cancelled a request it no longer had a window for.
let posts: { url: string; body: unknown; signal?: AbortSignal | null }[] = [];

function stub(opts: { modelPresent?: boolean; indexStatus?: number; pullHangs?: boolean; pullFails?: boolean } = {}) {
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
    if (url.startsWith("/setup-api/embed/status")) {
      return json({ supported: true, installed: !!opts.modelPresent, model: "qwen3-embedding-0.6b", engine: "llama.cpp" });
    }
    if (url === "/setup-api/embed/install" && init?.method === "POST") {
      posts.push({ url, body: null, signal: init.signal });
      if (opts.pullHangs) {
        // A download that never finishes: the stream stays open until the
        // client goes away, which is exactly what the real route does.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":"Fetching the memory-search model (Qwen3-Embedding, about 640 MB)…"}\n'));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      }
      // The route's NDJSON: journal lines while the root step runs, then one
      // closing line. A failure arrives in-stream as a 200 with {error}.
      const body = opts.pullFails
        ? '{"status":"Fetching…"}\n{"error":"hf: connection reset"}\n'
        : '{"status":"Fetching…"}\n{"status":"Qwen3-Embedding-0.6B-Q8_0.gguf:  50%|#####     | 320M/639M"}\n{"success":true,"status":"The memory-search model is on this box."}\n';
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (url === "/setup-api/clawkeep/memory/index" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const status = opts.indexStatus ?? 200;
      return json(status === 200 ? { ok: true } : { error: "nope" }, status);
    }
    if (init?.method) posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return json({ ok: true });
  }));
}

beforeEach(() => stub());
afterEach(() => vi.unstubAllGlobals());

/** Intro -> folders -> schedule -> provision, and press the button. */
async function runProvision(done: () => void) {
  const rendered = render(<MemoryShardWizard onDone={done} />);
  fireEvent.click(await screen.findByTestId("memory-shard-enable"));
  fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
  fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
  fireEvent.click(screen.getByTestId("memory-shard-index-now"));
  return rendered;
}

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

  it("fetches the model, points the index at the embedder, and only then marks setup done", async () => {
    const done = vi.fn();
    await runProvision(done);

    await waitFor(() => expect(done).toHaveBeenCalled());

    const order = posts.map((p) => p.url);
    expect(order).toContain("/setup-api/embed/install");
    // No engine is enabled or started here: the proxy wakes the embedder on
    // every search, and there is no Ollama left to switch on.
    expect(posts.find((p) => p.url === "/setup-api/local-models")).toBeUndefined();
    expect(order.some((u) => u.startsWith("/setup-api/ollama"))).toBe(false);
    expect(order.indexOf("/setup-api/clawkeep/memory/provider")).toBeGreaterThan(order.indexOf("/setup-api/embed/install"));
    // Under the route's own field names. The route replaces the whole
    // schedule and resets any field it does not recognise, so a body that
    // said `time`/`dayOfWeek` quietly saved 03:00 on Sunday whatever was
    // picked — the defaults here are the same values, which is what hid it.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/schedule")?.body)
      .toEqual({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    // The completion flag is LAST, with the switch, after everything that can fail.
    const enable = posts.find((p) => p.url === "/setup-api/clawkeep/memory/enable");
    expect(enable?.body).toEqual({ enabled: true, setupComplete: true });
    expect(order.indexOf("/setup-api/clawkeep/memory/index"))
      .toBeGreaterThan(order.indexOf("/setup-api/clawkeep/memory/enable"));
  });

  it("asks for a FULL first pass, because the provider switch changed the index identity", async () => {
    const done = vi.fn();
    await runProvision(done);
    await waitFor(() => expect(done).toHaveBeenCalled());
    // OpenClaw pauses vector search over an index built for another provider
    // until it is rebuilt; the route's own incremental→full upgrade fires only
    // on an EMPTY index, not a stale one.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/index")?.body).toEqual({ mode: "full" });
  });

  it("skips the download when the model is already on the box", async () => {
    stub({ modelPresent: true });
    const done = vi.fn();
    await runProvision(done);
    await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/clawkeep/memory/enable")).toBe(true));
    expect(posts.find((p) => p.url === "/setup-api/embed/install")).toBeUndefined();
  });

  it("says so in the wizard when the download fails, and does not finish", async () => {
    stub({ pullFails: true });
    const done = vi.fn();
    await runProvision(done);
    // The route's own error line reaches the owner as it was said.
    expect(await screen.findByText("hf: connection reset")).toBeInTheDocument();
    expect(clawkeepTranslations.en[PULL_FAILED]).toBe("Could not download the embedding model.");
    expect(done).not.toHaveBeenCalled();
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")).toBeUndefined();
  });

  it("says so in the wizard when the first pass could not be started, and does not finish", async () => {
    stub({ indexStatus: 500 });
    const done = vi.fn();
    await runProvision(done);
    // The message is the wizard's own: the card that would replace it can only
    // show "never ran", with no reason attached.
    expect(await screen.findByText(START_FAILED)).toBeInTheDocument();
    expect(clawkeepTranslations.en[START_FAILED]).toBe("Indexing could not be started. Try again.");
    expect(done).not.toHaveBeenCalled();
    // The switch and the flag were written before the pass was asked for, so
    // they are not what the failure is about.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/enable")?.body)
      .toEqual({ enabled: true, setupComplete: true });
  });

  it("treats a 409 from the index route as the box already indexing, and finishes", async () => {
    stub({ indexStatus: 409 });
    const done = vi.fn();
    await runProvision(done);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.queryByText(START_FAILED)).not.toBeInTheDocument();
  });

  it("aborts the download when the window closes mid-fetch", async () => {
    stub({ pullHangs: true });
    const done = vi.fn();
    const { unmount } = await runProvision(done);

    await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/embed/install")).toBe(true));
    const pull = posts.find((p) => p.url === "/setup-api/embed/install");
    expect(pull?.signal?.aborted).toBe(false);

    unmount();

    // The install route follows a root unit; a fetch left running after the
    // window closed would keep its client — and the download itself goes on
    // as root, which is the right outcome for a 640 MB file half fetched.
    expect(pull?.signal?.aborted).toBe(true);
    expect(done).not.toHaveBeenCalled();
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")).toBeUndefined();
  });
});
