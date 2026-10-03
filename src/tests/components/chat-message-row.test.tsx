// One bubble of the mascot chat, split out of ChatPopup so React can skip it.
//
// The popup renders on every keystroke in the composer, every streamed chunk
// and every desktop render, and while the bubbles were built inline each of
// those renders parsed the Markdown of every reply in the conversation again.
// These pin the two halves of the move: the bubble draws what the popup drew,
// and it is drawn again only when what it shows has changed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@/tests/helpers/test-utils";

vi.mock("@/lib/chat-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-markdown")>();
  return { ...actual, renderText: vi.fn(actual.renderText) };
});
// The player fetches and decodes its clip; what is under test here is whether
// the bubble renders at all, so a plain stand-in is all it needs to be.
vi.mock("@/components/SpokenReplyPlayer", () => ({
  default: ({ src, label }: { src: string; label: string }) => <div data-testid="player" data-src={src} aria-label={label} />,
}));

import { renderText } from "@/lib/chat-markdown";
import {
  ChatMessageRow,
  NO_AUDIO_NOTES,
  StreamingReplyBubble,
  USER_CLAMP_CHARS,
  samePlainData,
  type ChatMessageRowProps,
  type ChatRowMessage,
} from "@/components/ChatMessageRow";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;
const parses = () => vi.mocked(renderText).mock.calls.length;

const REPLY: ChatRowMessage = {
  role: "assistant",
  text: "## Plan\n\n- **one**\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  timestamp: 1_700_000_000_000,
  toolCalls: [{ name: "bash", detail: "ls -la", status: "ok" }],
};

// One function each, as the popup's are (setters and a useCallback): a fresh
// closure per render is a changed prop, and the row would rightly draw again.
const noop = () => {};

function rowProps(over: Partial<ChatMessageRowProps> = {}): ChatMessageRowProps {
  return {
    msg: REPLY,
    longKey: `0:${REPLY.timestamp}`,
    expanded: false,
    onToggleExpand: noop,
    served: null,
    t,
    onPreview: noop,
    onOpenEmail: noop,
    cloudSpoken: NO_AUDIO_NOTES,
    autoplayBlocked: NO_AUDIO_NOTES,
    ...over,
  };
}

/**
 * The popup around a row, as far as the row can tell: a parent with state of
 * its own (the composer's text) that renders again without touching the row's
 * props, plus a way to hand the row new ones.
 */
let typeInComposer: () => void = () => {};
let setRowProps: (props: ChatMessageRowProps) => void = () => {};
function Popup({ initial }: { initial: ChatMessageRowProps }) {
  const [input, setInput] = useState("");
  const [props, setProps] = useState(initial);
  useEffect(() => {
    typeInComposer = () => setInput((s) => `${s}x`);
    setRowProps = setProps;
  }, []);
  return (
    <div>
      <textarea value={input} readOnly data-testid="composer" />
      <ChatMessageRow {...props} />
    </div>
  );
}

beforeEach(() => {
  vi.mocked(renderText).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("a reply in the transcript", () => {
  it("is parsed once, not again on every keystroke the owner types", () => {
    render(<Popup initial={rowProps()} />);
    expect(parses()).toBe(1);
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();

    for (let i = 0; i < 5; i++) act(() => typeInComposer());

    expect((screen.getByTestId("composer") as HTMLTextAreaElement).value).toBe("xxxxx");
    expect(parses()).toBe(1);
  });

  it("is not parsed again when a history read rebuilds the same message", () => {
    render(<Popup initial={rowProps()} />);
    // What a reconcile hands back: every message a NEW object, equal in every
    // field to the one on screen.
    const rebuilt: ChatRowMessage = JSON.parse(JSON.stringify(REPLY));
    expect(rebuilt).not.toBe(REPLY);

    act(() => setRowProps(rowProps({ msg: rebuilt })));

    expect(parses()).toBe(1);
  });

  it("is drawn again the moment its words change", () => {
    render(<Popup initial={rowProps()} />);

    act(() => setRowProps(rowProps({ msg: { ...REPLY, text: "Done — **all green**." } })));

    expect(parses()).toBe(2);
    expect(screen.getByText("all green")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Plan" })).toBeNull();
  });

  it("is drawn again when the model that served it arrives", () => {
    render(<Popup initial={rowProps()} />);
    expect(screen.queryByTestId("chat-served-model")).toBeNull();

    act(() => setRowProps(rowProps({ served: "Claude · claude-opus-4" })));

    expect(screen.getByTestId("chat-served-model").textContent).toBe("Claude · claude-opus-4");
  });

  it("follows the language: a new `t` draws the labels again", () => {
    render(<Popup initial={rowProps({ served: "Gemma" })} />);
    const german = (key: string) => (key === "chat.servedBy" ? "Beantwortet von" : key);

    act(() => setRowProps(rowProps({ served: "Gemma", t: german })));

    expect(screen.getByTestId("chat-served-model").getAttribute("aria-label")).toBe("Beantwortet von: Gemma");
  });
});

describe("a spoken reply's notes", () => {
  const SPOKEN: ChatRowMessage = { role: "assistant", text: "Sure.", timestamp: 5, audio: ["blob:clip-1"] };

  it("are drawn under the player whose clip they name", () => {
    render(<Popup initial={rowProps({ msg: SPOKEN, cloudSpoken: [], autoplayBlocked: [] })} />);
    expect(screen.queryByTestId("chat-audio-cloud")).toBeNull();

    act(() => setRowProps(rowProps({ msg: SPOKEN, cloudSpoken: ["blob:clip-1"], autoplayBlocked: ["blob:clip-1"] })));

    expect(screen.getByTestId("chat-audio-cloud").textContent).toBe("chat.spokenByCloud");
    expect(screen.getByTestId("chat-audio-blocked").textContent).toBe("chat.tapToHearReply");
  });

  it("do not draw the bubble again when the list is rebuilt with the same clips", () => {
    render(<Popup initial={rowProps({ msg: SPOKEN, cloudSpoken: ["blob:clip-1"], autoplayBlocked: [] })} />);
    const before = parses();

    act(() => setRowProps(rowProps({ msg: SPOKEN, cloudSpoken: ["blob:clip-1"], autoplayBlocked: [] })));

    expect(parses()).toBe(before);
  });
});

describe("a long paste from the owner", () => {
  const PASTE: ChatRowMessage = { role: "user", text: `${"word ".repeat(200)}END`, timestamp: 9 };

  it("folds behind Show more, and asks the popup to unfold it by its key", () => {
    const onToggleExpand = vi.fn();
    render(<Popup initial={rowProps({ msg: PASTE, longKey: "3:9", onToggleExpand })} />);
    expect(PASTE.text.length).toBeGreaterThan(USER_CLAMP_CHARS);
    expect(screen.queryByText(/END/)).toBeNull();

    fireEvent.click(screen.getByTestId("chat-user-expand"));
    expect(onToggleExpand).toHaveBeenCalledWith("3:9");

    act(() => setRowProps(rowProps({ msg: PASTE, longKey: "3:9", onToggleExpand, expanded: true })));
    expect(screen.getByText(/END$/)).toBeTruthy();
    expect(screen.getByTestId("chat-user-expand").getAttribute("aria-expanded")).toBe("true");
    // The owner's own words are never parsed as Markdown.
    expect(parses()).toBe(0);
  });
});

describe("a picture in a bubble", () => {
  const PICTURE: ChatRowMessage = { role: "assistant", text: "", timestamp: 2, images: ["/setup-api/chat/media?path=a.png"] };

  it("opens the preview with its own accessible name", () => {
    const onPreview = vi.fn();
    render(<Popup initial={rowProps({ msg: PICTURE, onPreview })} />);
    fireEvent.click(screen.getByRole("button", { name: "chat.generatedImage" }));
    expect(onPreview).toHaveBeenCalledWith({ src: PICTURE.images![0], alt: "chat.generatedImage" });
  });

  it("carries its download chip without a backdrop blur, on a slightly darker fill", () => {
    render(<Popup initial={rowProps({ msg: PICTURE })} />);
    const chip = screen.getByRole("link", { name: "chat.downloadImage" });
    // A blur here is one more render surface per picture, re-blurred on every
    // frame of a transcript scroll; the fill makes up for it.
    expect(chip.style.backdropFilter).toBe("");
    expect(chip.style.background).toBe("rgba(0, 0, 0, 0.62)");
  });
});

describe("the reply while it streams in", () => {
  it("is parsed again for each new chunk, and not for anything else the popup does", () => {
    let setText: (s: string) => void = () => {};
    let bump: () => void = () => {};
    function Host() {
      const [text, set] = useState("Hel");
      const [, setN] = useState(0);
      useEffect(() => {
        setText = set;
        bump = () => setN((n) => n + 1);
      }, []);
      return <StreamingReplyBubble text={text} t={t} />;
    }
    render(<Host />);
    expect(parses()).toBe(1);

    act(() => bump());
    act(() => bump());
    expect(parses()).toBe(1);

    act(() => setText("Hello **there**"));
    expect(parses()).toBe(2);
    expect(screen.getByText("there")).toBeTruthy();
  });
});

describe("samePlainData", () => {
  it.each([
    ["equal primitives", 1, 1, true],
    ["NaN and NaN", Number.NaN, Number.NaN, true],
    ["different strings", "a", "b", false],
    ["equal nested data", { a: [1, { b: "c" }] }, { a: [1, { b: "c" }] }, true],
    ["a changed leaf", { a: [1, { b: "c" }] }, { a: [1, { b: "d" }] }, false],
    ["an added key, even an undefined one", { a: 1 }, { a: 1, b: undefined }, false],
    ["arrays of different length", [1, 2], [1, 2, 3], false],
    ["an array and an object", [1], { 0: 1 }, false],
    ["null and an object", null, {}, false],
  ])("%s", (_name, a, b, expected) => {
    expect(samePlainData(a, b)).toBe(expected);
  });

  it("compares anything that is not plain data by identity", () => {
    const when = new Date(0);
    expect(samePlainData({ when }, { when })).toBe(true);
    expect(samePlainData({ when }, { when: new Date(0) })).toBe(false);
  });
});
