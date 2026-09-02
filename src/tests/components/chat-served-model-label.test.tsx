import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@/tests/helpers/test-utils";
import { HERMES_SESSION, installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * HERMES-05 — the chat could not say which model answered.
 *
 * The served model and provider were recorded per turn (the route writes them
 * into the transcript, the transport hands them back on `done`), but nothing
 * on screen ever showed them. So an owner who switched models in the header
 * and asked "which model are you" had only the model's word for it — and the
 * model, reading the device DEFAULT off its tools, answered wrong.
 *
 * The bubble now carries a small label with what actually answered. Only a
 * reply that knows its model gets one; a row stored before the field existed
 * renders exactly as before.
 */

const LABEL = "chat-served-model";

/** Resolves the streamed body's next chunk, so a test can pace the stream. */
let releaseChunk: ((chunk: string | null) => void) | null = null;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE Response whose chunks are handed out one `releaseChunk` at a time. */
function pacedStream(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

/**
 * The shared box with the turn upgraded to a paced stream — the same shape
 * chat-clarify.test.tsx uses. The helper's fetch is kept for every other route.
 */
function installStreamingBox(): HermesBox {
  const box = installHermesBox();
  box.facts.hermesStreamsTurns = true;
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/setup-api/hermes/chat")) return pacedStream();
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

/** Hand the stream one chunk and let the component settle. */
async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  releaseChunk = null;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("which model answered, on the bubble", () => {
  it("labels a replayed reply with what served it, and only that reply", async () => {
    const box = installHermesBox();
    box.storedTranscript = [
      { role: "assistant", text: "Older reply.", timestamp: 1 },
      { role: "user", text: "which model are you", timestamp: 2 },
      { role: "assistant", text: "Served reply.", timestamp: 3, model: "deepseek-v4-flash", provider: "clawai" },
    ];
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByText(/Served reply\./)).toBeTruthy());

    // One label on the whole thread — the reply that never recorded a model
    // renders as it always did — and it names the provider by its display
    // name, not its slug.
    const labels = screen.getAllByTestId(LABEL);
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain("deepseek-v4-flash");
    expect(labels[0].textContent).toContain("ClawBox AI");
  });

  it("prints the full model id and a provider the catalogue, not the static table, names", async () => {
    // `nebius` has no curated label, so the display name can only come from
    // the box's own provider list — the half of hermesProviderName the clawai
    // case above never exercises. And the id is shown whole: a vendor-prefixed
    // id cut to its last segment is not the record, and a mouse-only title is
    // not visible.
    const box = installHermesBox();
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes("/setup-api/hermes/models")) {
          // The helper's mount waits for this URL to have been fetched.
          box.fetchedUrls.push(String(input));
          return {
            ok: true,
            json: async () => ({
              providers: [
                { id: "clawlocal", name: "On this box", authenticated: true },
                { id: "nebius", name: "Nebius AI", authenticated: true },
              ],
              models: [{ id: "gemma", name: "Gemma" }],
              provider: "clawlocal",
              current: "gemma",
              defaultModel: "gemma",
              reasoning: "off",
            }),
          };
        }
        return inner(input as RequestInfo, init);
      }),
    );
    box.storedTranscript = [
      { role: "assistant", text: "Routed reply.", timestamp: 1, model: "anthropic/claude-fable-5", provider: "nebius" },
    ];
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByText(/Routed reply\./)).toBeTruthy());

    const label = screen.getByTestId(LABEL);
    expect(label.textContent).toContain("Nebius AI");
    expect(label.textContent).toContain("anthropic/claude-fable-5");
    // Visible means visible: a line that clips to an ellipsis and keeps the
    // rest in a mouse-only title is not.
    expect(label.style.whiteSpace).not.toBe("nowrap");
    expect(label.style.textOverflow).toBe("");
    expect(label.getAttribute("title")).toBeNull();
  });

  it("shows the label on a live turn the moment it settles", async () => {
    const textarea = await mountHermesChat(installStreamingBox());
    fireEvent.change(textarea, { target: { value: "which model are you" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await push(frame("delta", { text: "I am" }));
    await waitFor(() => expect(screen.getByText(/I am/)).toBeTruthy());
    // Nothing to claim yet: the model is known when the turn settles.
    expect(screen.queryByTestId(LABEL)).toBeNull();

    await push(
      frame("done", {
        text: "I am whatever the label says.",
        harness: "hermes",
        sessionId: HERMES_SESSION,
        model: "gpt-5.6-sol",
        provider: "openai",
      }),
    );
    await push(null);

    await waitFor(() => expect(screen.getByTestId(LABEL).textContent).toContain("gpt-5.6-sol"));
    // The provider half travels the same `done` frame and is just as easy to
    // drop on the live path alone. `openai` is not in this box's catalogue, so
    // it has no display name to resolve to and the label falls back to the raw
    // slug — honest, and the case the replayed test above does not cover.
    expect(screen.getByTestId(LABEL).textContent).toContain("openai ·");
  });
});

/**
 * A source assertion, deliberately, and for the reason
 * chat-model-pill-stability.test.tsx gives for its own: the behaviour depends
 * on two history reads reconciling against a live bubble whose timestamp the
 * test cannot control, and the thing worth pinning is the RULE — a per-message
 * field that can arrive late has to be named in the comparator, or React skips
 * the repaint and the label never appears.
 */
describe("the transcript comparator", () => {
  it("counts a reply that gained its served model as changed", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "ChatPopup.tsx"), "utf8");
    const sameTranscript = /function sameTranscript[\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(sameTranscript).toMatch(/x\.model !== y\.model \|\| x\.provider !== y\.provider/);
  });
});
