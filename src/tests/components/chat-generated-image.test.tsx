import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A generated picture reaches the chat as a `MEDIA:<path>` line inside the
 * reply text — the harness sends no structured attachment (see
 * lib/chat-media.ts). Before this was handled, the mascot chat rendered the
 * caption and dropped the image entirely.
 *
 * Driven through the Hermes reply branch because it needs no gateway
 * handshake; the OpenClaw branch runs the same splitAssistantMedia() call.
 */

const IMAGE_PATH =
  "/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458.png";
const REPLY = `Here's your cat! \u{1F431}\n\nMEDIA:${IMAGE_PATH}`;

function installFetch(replyText: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        return { ok: true, json: async () => ({ text: replyText, sessionId: "s1" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return {
          ok: true,
          json: async () => ({
            provider: "clawai",
            current: "clawai/model-a",
            reasoning: "medium",
            providers: [{ id: "clawai", name: "ClawBox AI", authenticated: true }],
            models: [],
            defaultModel: "clawai/model-a",
            authenticated: true,
            savedElsewhere: null,
            source: "dashboard",
            stale: false,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function send(text: string) {
  const box = await screen.findByRole("textbox");
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom has no layout engine for the message list's auto-scroll.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("a generated image in the mascot chat", () => {
  it("renders the picture the reply named, through the media route", async () => {
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");

    const img = await screen.findByRole("img");
    expect(img).toHaveAttribute(
      "src",
      `/setup-api/chat/media?path=${encodeURIComponent(IMAGE_PATH)}`,
    );
  });

  it("shows the caption without the raw directive line", async () => {
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");

    expect(await screen.findByText(/Here's your cat!/)).toBeInTheDocument();
    // The path must never be shown as text — that was the visible symptom.
    expect(screen.queryByText(new RegExp(IMAGE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull();
    expect(screen.queryByText(/MEDIA:/)).toBeNull();
  });

  it("still renders the picture when the reply is nothing but the directive", async () => {
    installFetch(`MEDIA:${IMAGE_PATH}`);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");

    expect(await screen.findByRole("img")).toBeInTheDocument();
    // An image-only reply is a real answer, not an empty one.
    expect(screen.queryByText("(no response)")).toBeNull();
  });

  it("offers the picture for download under its own filename", async () => {
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");

    const link = await screen.findByRole("link", { name: "chat.downloadImage" });
    expect(link).toHaveAttribute(
      "href",
      `/setup-api/chat/media?path=${encodeURIComponent(IMAGE_PATH)}`,
    );
    // The name the harness gave it, not "route" or "media".
    expect(link).toHaveAttribute("download", "image-1---84d24458.png");
  });

  it("opens the full-size preview when the picture is clicked", async () => {
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "chat.generatedImage" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("img")).toBeInTheDocument();
    // Everything behind the panel is inerted by the shared modal trap, so the
    // thumbnail is no longer in the accessibility tree — only the preview is.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("closes the preview on its close button, leaving the chat open", async () => {
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("generate image of cat");
    fireEvent.click(await screen.findByRole("button", { name: "chat.generatedImage" }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "chat.closePreview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The conversation survives the dismissal.
    expect(screen.getByText(/Here's your cat!/)).toBeInTheDocument();
  });

  it("dismisses the preview on Escape without closing the chat", async () => {
    const onClose = vi.fn();
    installFetch(REPLY);
    render(<ChatPopup isOpen onClose={onClose} />);
    await send("generate image of cat");
    fireEvent.click(await screen.findByRole("button", { name: "chat.generatedImage" }));
    await screen.findByRole("dialog");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The trap stopped the key at the document capture phase, so the chat's
    // own window listener never saw it.
    expect(onClose).not.toHaveBeenCalled();

    // With the preview gone, Escape bubbles through to the chat again.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves an ordinary reply alone", async () => {
    installFetch("Just text, no picture.");
    render(<ChatPopup isOpen onClose={() => {}} />);
    await send("hi");

    expect(await screen.findByText("Just text, no picture.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
