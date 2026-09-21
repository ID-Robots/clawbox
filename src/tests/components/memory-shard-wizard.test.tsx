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
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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

/**
 * The ClawBox AI account this box is on, as /setup-api/ai-models/status
 * answers it. The wizard's first step is behind the paid-plan gate (owner's
 * decision, 2026-09-14), so every walk through it needs a paid plan on record;
 * `plan: "free"` and `plan: "none"` are the two refusals.
 */
type Plan = "flash" | "pro" | "free" | "none";

function stub(opts: { modelPresent?: boolean; indexStatus?: number; pullHangs?: boolean; pullFails?: boolean; pullTruncated?: boolean; plan?: Plan; provider?: unknown; holdProvider?: Promise<void> } = {}) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (url === "/setup-api/ai-models/status") {
      const plan = opts.plan ?? "flash";
      return json({
        clawaiConfigured: plan !== "none",
        clawaiAccountTier: plan === "flash" || plan === "pro" ? plan : null,
      });
    }
    if (url.startsWith("/setup-api/clawkeep/memory/sources")) {
      if (init?.method) posts.push({ url: "/setup-api/clawkeep/memory/sources", body: JSON.parse(String(init.body)) });
      return json({ paths: [] });
    }
    if (url.startsWith("/setup-api/coding-agent/browse")) {
      return json({ root: "/home/clawbox", path: "/home/clawbox", parent: null, entries: [{ name: "Documents", path: "/home/clawbox/Documents" }] });
    }
    // Where the model may run. Unset, the route is absent — an older server —
    // and the wizard keeps the model on this box, which every walk below
    // that predates the choice relies on.
    if (url === "/setup-api/clawkeep/memory/provider" && !init?.method) {
      if (opts.holdProvider) await opts.holdProvider;
      return opts.provider === undefined ? json({ error: "not here" }, 404) : json(opts.provider);
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
      // A TRUNCATED stream — the web server restarted or the connection
      // dropped mid-download — is a 200 that ends with neither.
      const body = opts.pullFails
        ? '{"status":"Fetching…"}\n{"error":"hf: connection reset"}\n'
        : opts.pullTruncated
          ? '{"status":"Fetching…"}\n{"status":"Qwen3-Embedding-0.6B-Q8_0.gguf:  50%|#####     | 320M/639M"}\n'
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

/**
 * Leave the intro. The first step is behind the paid-plan gate, and the gate's
 * own poll has to answer before the button is anything but disabled — the hook
 * starts every mount at "not signed in" and only the first tick settles it.
 */
async function leaveIntro() {
  const enable = await screen.findByTestId("memory-shard-enable");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
}

beforeEach(() => stub());
afterEach(() => vi.unstubAllGlobals());

/** Intro -> folders -> schedule -> provision, and press the button. */
async function runProvision(done: () => void) {
  const rendered = render(<MemoryShardWizard onDone={done} />);
  await leaveIntro();
  fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
  fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
  // Held until the read of where the model may run has answered.
  const indexNow = screen.getByTestId("memory-shard-index-now");
  await waitFor(() => expect(indexNow).not.toBeDisabled());
  fireEvent.click(indexNow);
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
    await leaveIntro();
    expect(screen.getByTestId("memory-shard-browse")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    expect(screen.getByTestId("memory-shard-time")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    expect(screen.getByTestId("memory-shard-index-now")).toBeInTheDocument();
  });

  it("adds a folder through the picker", async () => {
    render(<MemoryShardWizard onDone={() => {}} />);
    await leaveIntro();
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

  it("uses the ClawBox AI cloud model when the plan covers it, and downloads nothing", async () => {
    stub({ provider: { source: "local", cloudSupported: true, cloudAvailable: true, localInstalled: false } });
    const done = vi.fn();
    render(<MemoryShardWizard onDone={done} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    await waitFor(() => expect(screen.getByTestId("memory-shard-source-cloud")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("memory-shard-provision-body")).toHaveTextContent("clawkeep.memory.setup.provisionBodyCloud");
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.find((p) => p.url === "/setup-api/embed/install")).toBeUndefined();
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")?.body).toEqual({ source: "cloud" });
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/index")?.body).toEqual({ mode: "full" });
    expect(clawkeepTranslations.en["clawkeep.memory.setup.provisionBodyCloud"]).toBeTruthy();
  });

  it("lets the owner keep the model on this box instead of the cloud one", async () => {
    stub({ provider: { source: "local", cloudSupported: true, cloudAvailable: true, localInstalled: false } });
    const done = vi.fn();
    render(<MemoryShardWizard onDone={done} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    await waitFor(() => expect(screen.getByTestId("memory-shard-source-cloud")).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByTestId("memory-shard-source-local"));
    expect(screen.getByTestId("memory-shard-source-local")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.find((p) => p.url === "/setup-api/embed/install")).toBeDefined();
    // The body-less call is the model on this box, as it always was.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")?.body).toBeNull();
  });

  it("offers the model on this box alone when the cloud one is not available, and says so", async () => {
    stub({ provider: { source: "local", cloudSupported: true, cloudAvailable: false, localInstalled: false } });
    render(<MemoryShardWizard onDone={() => {}} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    expect(await screen.findByTestId("memory-shard-source-cloud")).toBeDisabled();
    expect(screen.getByTestId("memory-shard-source-local")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("memory-shard-source-cloud-unavailable")).toBeInTheDocument();
  });

  /** Straight to step 3, with the provider read already answered. */
  async function atProvisionStep(provider: unknown) {
    stub({ provider });
    const done = vi.fn();
    render(<MemoryShardWizard onDone={done} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    await waitFor(() => expect(screen.getByTestId("memory-shard-index-now")).not.toBeDisabled());
    return done;
  }

  it("keeps the ClawBox AI cloud selected on a box whose index is already embedded there", async () => {
    // `cloudAvailable` is a LIVE probe of the proxy's embeddings route and
    // answers false on any hiccup. That may not pre-select a box that is
    // already indexing in the cloud onto the 640 MB model on this box: the
    // settings card has never allowed that (its own `blocked` exempts a box
    // already on the cloud) and Index now here would post the move.
    const done = await atProvisionStep({ source: "cloud", recorded: true, cloudSupported: true, cloudAvailable: false, localInstalled: false });
    expect(screen.getByTestId("memory-shard-source-cloud")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("memory-shard-source-cloud")).not.toBeDisabled();
    expect(screen.queryByTestId("memory-shard-source-cloud-unavailable")).toBeNull();

    fireEvent.click(screen.getByTestId("memory-shard-index-now"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.find((p) => p.url === "/setup-api/embed/install")).toBeUndefined();
    // …and no switch is asked for either: the choice is RECORDED, the index is
    // already there, and the route's switch re-checks the very probe that just
    // answered false — so posting it would turn a hiccup into a 409 over an
    // index that was never going to move. The wizard finishes on what the box
    // already has.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")).toBeUndefined();
  });

  it("STILL posts on a box that embeds in the cloud by DEFAULT, because nothing is written down", async () => {
    // The whole of H-1. Since the owner's ruling of 2026-09-18 the GET answers
    // `source: "cloud"` from an UNWRITTEN default — every freshly onboarded,
    // subscribed box — so a wizard that read `source` alone as "nothing to do"
    // finished without the pin and without the owner mark. The first pass then
    // indexed the owner's whole Documents folder in the cloud, correctly and at
    // their expense, and the very next web-server restart's automatic promotion
    // saw an unrecorded box, wrote the pin and asked for a FULL rebuild: hours
    // of re-embedding paid for twice, with memory search answering nothing
    // throughout. The POST is what records the choice, so the cloud path takes
    // it whenever `recorded` is false.
    const done = await atProvisionStep({ source: "cloud", recorded: false, cloudSupported: true, cloudAvailable: true, localInstalled: false });
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")?.body).toEqual({ source: "cloud" });
    // And still no 639 MB download: the cloud model needs none.
    expect(posts.find((p) => p.url === "/setup-api/embed/install")).toBeUndefined();
  });

  it("posts on a server too old to say whether anything is recorded", async () => {
    // `parseEmbedderChoiceStatus` reads a missing `recorded` as false, which is
    // the safe direction: posting a choice that was already made costs one
    // idempotent write, skipping the one that records it costs a full reindex.
    const done = await atProvisionStep({ source: "cloud", cloudSupported: true, cloudAvailable: true, localInstalled: false });
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")?.body).toEqual({ source: "cloud" });
  });

  it("says WHY the cloud model cannot be picked and what makes it available, reason by reason", async () => {
    // "not available on this box right now" named neither the cause nor the
    // cure, so the commonest one of all — a box with no ClawBox AI credential
    // on it yet — read as a fault of the box (owner, 2026-09-17).
    const notes: [string, string][] = [
      ["not_linked", "clawkeep.memory.embedder.cloudNotLinked"],
      ["plan", "clawkeep.memory.embedder.cloudPlan"],
      ["route_unavailable", "clawkeep.memory.embedder.cloudRouteDown"],
    ];
    for (const [reason, key] of notes) {
      cleanup();
      await atProvisionStep({ source: "local", cloudSupported: true, cloudAvailable: false, cloudReason: reason, localInstalled: false });
      expect(screen.getByTestId("memory-shard-source-cloud-unavailable"), reason).toHaveTextContent(key);
      expect(clawkeepTranslations.en[key], key).toBeTruthy();
    }
    // The remedy, not a restatement of the symptom.
    expect(clawkeepTranslations.en["clawkeep.memory.embedder.cloudNotLinked"]).toMatch(/Settings/);
  });

  it("falls back to the generic note when the box could not say why", async () => {
    await atProvisionStep({ source: "local", cloudSupported: true, cloudAvailable: false, localInstalled: false });
    expect(screen.getByTestId("memory-shard-source-cloud-unavailable"))
      .toHaveTextContent("clawkeep.memory.embedder.cloudUnavailable");
  });

  it("holds Index now until the read of where the model may run has answered", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    stub({ provider: { source: "local", cloudSupported: true, cloudAvailable: true, localInstalled: false }, holdProvider: hold });
    render(<MemoryShardWizard onDone={() => {}} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    expect(screen.getByTestId("memory-shard-index-now")).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByTestId("memory-shard-index-now")).not.toBeDisabled());
    expect(screen.getByTestId("memory-shard-source-cloud")).toHaveAttribute("aria-checked", "true");
  });

  it("draws no choice on the edition that indexes on the box itself", async () => {
    stub({ provider: { source: "local", cloudSupported: false, cloudAvailable: false, localInstalled: false } });
    render(<MemoryShardWizard onDone={() => {}} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    await screen.findByTestId("memory-shard-index-now");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("memory-shard-source")).toBeNull();
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

  it("treats a download stream that ends without its closing line as a failed download", async () => {
    // The route's contract is ONE closing {success} or {error}. A stream that
    // simply ends — the web server restarting mid-download, the connection
    // dropping — has said neither, and a wizard that read the end of the body
    // as "done" would switch the provider and start a full reindex against a
    // model that is not on the box, with the owner watching the ready phase.
    stub({ pullTruncated: true });
    const done = vi.fn();
    await runProvision(done);
    expect(await screen.findByText(PULL_FAILED)).toBeInTheDocument();
    expect(clawkeepTranslations.en[PULL_FAILED]).toBe("Could not download the embedding model.");
    expect(done).not.toHaveBeenCalled();
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/provider")).toBeUndefined();
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/enable")).toBeUndefined();
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

  it("holds Next while a folder is being added, so the owner cannot leave the step before the add is answered", async () => {
    // The add is a ~5 s CLI spawn. Next used to stay live through it: the
    // step unmounted mid-write, the write still landed, and a refusal of
    // that add was never seen by anyone.
    const inner = fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (input.toString().startsWith("/setup-api/clawkeep/memory/sources") && init?.method === "POST") await gate;
      return inner(input, init);
    }));
    render(<MemoryShardWizard onDone={vi.fn()} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-browse"));
    fireEvent.click(await screen.findByTestId("memory-shard-pick"));

    await waitFor(() => expect(screen.getByTestId("memory-shard-next-schedule")).toBeDisabled());
    release();
    await waitFor(() => expect(screen.getByTestId("memory-shard-next-schedule")).not.toBeDisabled());
    expect(posts).toEqual([{ url: "/setup-api/clawkeep/memory/sources", body: { path: "/home/clawbox" } }]);
  });

  it("saves the last VALID time when the field holds a half-typed one (ms-findings F-F)", async () => {
    // The home card already keeps a half-entered time in the field alone;
    // the wizard sent it as typed, the route sanitised "" to 03:00, and the
    // hour the owner had picked was quietly gone.
    const done = vi.fn();
    render(<MemoryShardWizard onDone={done} />);
    await leaveIntro();
    fireEvent.click(screen.getByTestId("memory-shard-next-schedule"));
    const field = screen.getByTestId("memory-shard-time") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "04:30" } });
    fireEvent.change(field, { target: { value: "" } });
    // The field shows what is being typed…
    expect(field.value).toBe("");
    fireEvent.click(screen.getByTestId("memory-shard-next-provision"));
    fireEvent.click(screen.getByTestId("memory-shard-index-now"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    // …and what is saved is the last time that was one.
    expect(posts.find((p) => p.url === "/setup-api/clawkeep/memory/schedule")?.body)
      .toEqual({ enabled: true, frequency: "daily", timeOfDay: "04:30", weekday: 0 });
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
