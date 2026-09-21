/**
 * Memory Shard's embedder card: the owner's switch between the ClawBox AI cloud
 * model and the model on this box (2026-09-15).
 *
 * What is pinned: a switch onto the model on this box fetches it first when it
 * is not there; either direction points the index there and then asks for a
 * FULL pass, because the index belongs to the embedder that wrote it; the cloud
 * is offered only where the box says it is; a refusal is said in the route's own
 * words and no pass is started over a switch that did not land.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { clawkeepTranslations } from "@/lib/clawkeep-translations";
import MemoryShardEmbedderCard from "@/components/MemoryShardEmbedderCard";

type Choice = {
  source: "cloud" | "local";
  cloudSupported: boolean;
  cloudAvailable: boolean;
  cloudReason?: string | null;
  localInstalled: boolean;
};

let choice: Choice;
let calls: { url: string; body: unknown }[];
let providerRefusal: string | null;

function stub() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "/setup-api/clawkeep/memory/provider" && !init?.method) return json(choice);
    if (init?.method === "POST") calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url === "/setup-api/embed/install") {
      choice = { ...choice, localInstalled: true };
      return new Response('{"status":"Fetching…"}\n{"success":true}\n', { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (url === "/setup-api/clawkeep/memory/provider") {
      if (providerRefusal) return json({ error: providerRefusal, kind: "cloud_unavailable" }, 409);
      const body = JSON.parse(String(init?.body)) as { source: "cloud" | "local" };
      choice = { ...choice, source: body.source };
      return json({ source: body.source });
    }
    if (url === "/setup-api/clawkeep/memory/index") return json({ accepted: true });
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => {
  choice = { source: "local", cloudSupported: true, cloudAvailable: true, localInstalled: true };
  providerRefusal = null;
  stub();
});
afterEach(() => vi.unstubAllGlobals());

const urls = () => calls.map((c) => c.url);

describe("MemoryShardEmbedderCard", () => {
  it("draws the choice the box reports", async () => {
    render(<MemoryShardEmbedderCard />);
    expect(await screen.findByTestId("memory-shard-embedder-local")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("memory-shard-embedder-cloud")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("memory-shard-embedder-cloud")).not.toBeDisabled();
  });

  it("moves onto the cloud without downloading anything, then asks for a full pass", async () => {
    render(<MemoryShardEmbedderCard />);
    fireEvent.click(await screen.findByTestId("memory-shard-embedder-cloud"));
    await waitFor(() => expect(urls()).toContain("/setup-api/clawkeep/memory/index"));
    expect(urls()).not.toContain("/setup-api/embed/install");
    expect(calls.find((c) => c.url === "/setup-api/clawkeep/memory/provider")?.body).toEqual({ source: "cloud" });
    expect(calls.find((c) => c.url === "/setup-api/clawkeep/memory/index")?.body).toEqual({ mode: "full" });
    await waitFor(() => expect(screen.getByTestId("memory-shard-embedder-cloud")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("memory-shard-embedder-switched")).toBeInTheDocument();
  });

  it("fetches the model for this box first when it is not there", async () => {
    choice = { source: "cloud", cloudSupported: true, cloudAvailable: true, localInstalled: false };
    render(<MemoryShardEmbedderCard />);
    fireEvent.click(await screen.findByTestId("memory-shard-embedder-local"));
    await waitFor(() => expect(urls()).toContain("/setup-api/clawkeep/memory/index"));
    const order = urls();
    expect(order.indexOf("/setup-api/embed/install")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("/setup-api/clawkeep/memory/provider")).toBeGreaterThan(order.indexOf("/setup-api/embed/install"));
    expect(calls.find((c) => c.url === "/setup-api/clawkeep/memory/provider")?.body).toEqual({ source: "local" });
  });

  it("does not offer the cloud where the box says it is not available, and says why", async () => {
    choice = { source: "local", cloudSupported: true, cloudAvailable: false, localInstalled: true };
    render(<MemoryShardEmbedderCard />);
    expect(await screen.findByTestId("memory-shard-embedder-cloud")).toBeDisabled();
    expect(screen.getByTestId("memory-shard-embedder-cloud-unavailable")).toBeInTheDocument();
  });

  it("says WHY the cloud is not on offer and what makes it available", async () => {
    // The card said "not available on this box right now" to a box that had
    // simply never been connected to ClawBox AI. Each reason has a different
    // fix, and the resolver already names them (CloudUnavailableReason).
    for (const [reason, key] of [
      ["not_linked", "clawkeep.memory.embedder.cloudNotLinked"],
      ["plan", "clawkeep.memory.embedder.cloudPlan"],
      ["route_unavailable", "clawkeep.memory.embedder.cloudRouteDown"],
    ] as const) {
      cleanup();
      choice = { source: "local", cloudSupported: true, cloudAvailable: false, cloudReason: reason, localInstalled: true };
      render(<MemoryShardEmbedderCard />);
      expect(await screen.findByTestId("memory-shard-embedder-cloud-unavailable"), reason).toHaveTextContent(key);
      expect(clawkeepTranslations.en[key], key).toBeTruthy();
    }
  });

  it("keeps the cloud selectable on a box already indexing there, whatever the probe says", async () => {
    choice = { source: "cloud", cloudSupported: true, cloudAvailable: false, cloudReason: "route_unavailable", localInstalled: true };
    render(<MemoryShardEmbedderCard />);
    expect(await screen.findByTestId("memory-shard-embedder-cloud")).not.toBeDisabled();
    expect(screen.queryByTestId("memory-shard-embedder-cloud-unavailable")).toBeNull();
  });

  it("says the edition indexes on the box itself, and offers no cloud there", async () => {
    choice = { source: "local", cloudSupported: false, cloudAvailable: false, localInstalled: true };
    render(<MemoryShardEmbedderCard />);
    expect(await screen.findByTestId("memory-shard-embedder-cloud")).toBeDisabled();
    expect(screen.getByTestId("memory-shard-embedder-cloud-unsupported")).toBeInTheDocument();
  });

  it("says a refusal in the route's own words and starts no pass over a switch that did not land", async () => {
    providerRefusal = "The ClawBox AI cloud model is not available on this box right now.";
    render(<MemoryShardEmbedderCard />);
    fireEvent.click(await screen.findByTestId("memory-shard-embedder-cloud"));
    expect(await screen.findByText(providerRefusal)).toBeInTheDocument();
    expect(urls()).not.toContain("/setup-api/clawkeep/memory/index");
    expect(screen.getByTestId("memory-shard-embedder-local")).toHaveAttribute("aria-checked", "true");
  });

  it("draws nothing for a server that predates the switch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const { container } = render(<MemoryShardEmbedderCard />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[data-testid="memory-shard-embedder-card"]')).toBeNull();
  });
});
