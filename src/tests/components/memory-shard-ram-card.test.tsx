/**
 * Memory Shard settings: the "Keep the index in RAM" card — off by default,
 * what it holds when on, the over-limit refusal and the switch-off reason in
 * words, and nothing at all on a server from before the setting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import MemoryShardSettingsPanel from "@/components/MemoryShardSettingsPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const MB = 1_048_576;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The ram route as given; every other request of the page answers 404. */
function stubRam(get: unknown, post?: (body: { on: boolean }) => Response) {
  const posts: Array<{ on: boolean }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (input.toString() !== "/setup-api/clawkeep/memory/ram") return json({}, 404);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { on: boolean };
      posts.push(body);
      return post!(body);
    }
    return get === null ? json({}, 404) : json(get);
  }));
  return posts;
}

const panel = () => render(<MemoryShardSettingsPanel state={{ enabled: true, setupComplete: true }} onChanged={vi.fn()} onReset={vi.fn()} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Keep the index in RAM", () => {
  it("is off by default; on, it says what it holds; off again, it stops", async () => {
    const posts = stubRam({ on: false, bytes: 300 * MB, files: 1, availableBytes: 4096 * MB, stopped: null }, ({ on }) =>
      json({ on, bytes: 300 * MB, files: 1, availableBytes: 4096 * MB, stopped: null }),
    );
    panel();
    const sw = await screen.findByTestId("memory-shard-ram-switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("memory-shard-ram-card")).toHaveTextContent("the system then frees that memory as other programs need it");
    expect(screen.queryByTestId("memory-shard-ram-holds")).toBeNull();
    fireEvent.click(sw);
    expect(await screen.findByTestId("memory-shard-ram-holds")).toHaveTextContent("Keeping 300 MB of index files in memory.");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(posts).toEqual([{ on: true }, { on: false }]);
    // The Memory Shard switch beside it is its own control.
    expect(screen.getByTestId("memory-shard-switch")).toHaveAttribute("aria-checked", "true");
  });

  it("shows the over-limit refusal in words and stays off", async () => {
    stubRam({ on: false, bytes: 3 * 1024 * MB, files: 1, availableBytes: 4 * 1024 * MB, stopped: null }, () =>
      json({ error: "too big", code: "too_big", on: false, bytes: 3 * 1024 * MB, files: 1, availableBytes: 4 * 1024 * MB, stopped: null }, 409),
    );
    panel();
    fireEvent.click(await screen.findByTestId("memory-shard-ram-switch"));
    expect(await screen.findByText("Not switched on: the index (3 GB) is more than half of the memory free now (4 GB).")).toBeInTheDocument();
    expect(screen.getByTestId("memory-shard-ram-switch")).toHaveAttribute("aria-checked", "false");
  });

  it("says why it switched itself off", async () => {
    stubRam({ on: false, bytes: 600 * MB, files: 2, availableBytes: 1000 * MB, stopped: { reason: "too_big", bytes: 600 * MB, availableBytes: 1000 * MB, at: "2026-11-28T12:00:00.000Z" } });
    panel();
    expect(await screen.findByTestId("memory-shard-ram-stopped")).toHaveTextContent("Switched itself off: the index (600 MB) grew past half of the memory free (1,000 MB).");
  });

  it("is not drawn on a server from before the setting", async () => {
    stubRam(null);
    panel();
    await screen.findByTestId("memory-shard-settings-panel");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("memory-shard-ram-card")).toBeNull();
  });
});
