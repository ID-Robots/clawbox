/**
 * `[embed url="…" title="…" /]` in an assistant reply (TASK-2879).
 *
 * OpenClaw tells the assistant a webchat reply may carry this shortcode, and
 * its Control UI strips it and draws it: a YouTube URL as a thumbnail card
 * with Play, a hosted Canvas document as a sandboxed frame. This renderer
 * printed it as raw text and the voice read it out. The reply is untrusted
 * text, so the cases below pin what is drawn as much as what is refused.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { plainTextForLabel, renderText } from "@/lib/chat-markdown";
import { speechTextFor } from "@/lib/speech-text";
import { shortSpeechTextFor } from "@/lib/short-speech-text";

const ID = "dQw4w9WgXcQ";

const LABELS = { play: "Play", openOnYouTube: "Open on YouTube", untitled: "Embedded content" };

function bubble(text: string, streaming = false) {
  return render(<div data-testid="bubble">{renderText(text, "Table", "Details", LABELS, streaming)}</div>);
}

function playerSrc(text: string): string | null {
  const { container, unmount } = bubble(text);
  const play = screen.queryByTestId("chat-embed-youtube-play");
  if (!play) {
    unmount();
    return null;
  }
  fireEvent.click(play);
  const src = container.querySelector("iframe")?.getAttribute("src") ?? null;
  unmount();
  return src;
}

describe("embed shortcode: YouTube", () => {
  it("draws a thumbnail card instead of the raw shortcode, and loads the player only after Play", () => {
    const { container } = bubble(
      `Here is the trailer.\n\n[embed url="https://www.youtube.com/watch?v=${ID}" title="Trailer" /]\n\nEnjoy.`,
    );

    expect(container.textContent).not.toContain("[embed");
    expect(container.textContent).not.toContain("/]");
    expect(container.textContent).toContain("Here is the trailer.");
    expect(container.textContent).toContain("Trailer");
    expect(container.textContent).toContain("Enjoy.");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    // Nothing from YouTube's player is loaded before the owner asks for it.
    expect(container.querySelector("iframe")).toBeNull();

    const open = screen.getByRole("link", { name: "Open on YouTube" });
    expect(open).toHaveAttribute("href", `https://www.youtube.com/watch?v=${ID}`);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(screen.getByTestId("chat-embed-youtube-play"));
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`);
    // The watch link stays for a video that cannot play inline.
    expect(screen.getByRole("link", { name: "Open on YouTube" })).toBeInTheDocument();
  });

  it("recognises every supported link form and keeps only the start time", () => {
    const nocookie = (query = "") => `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1${query}`;
    const embed = (url: string) => `[embed url="${url}" title="Video" /]`;
    expect(playerSrc(embed(`https://youtube.com/watch?v=${ID}&list=PL123&t=90`))).toBe(nocookie("&start=90"));
    expect(playerSrc(embed(`https://m.youtube.com/watch?feature=share&v=${ID}&t=1m30s`))).toBe(nocookie("&start=90"));
    expect(playerSrc(embed(`https://youtu.be/${ID}?si=tracking&t=1h2m3s`))).toBe(nocookie("&start=3723"));
    expect(playerSrc(embed(`https://www.youtube.com/shorts/${ID}`))).toBe(nocookie());
    expect(playerSrc(embed(`https://www.youtube.com/live/${ID}?start=12`))).toBe(nocookie("&start=12"));
    expect(playerSrc(embed(`https://www.youtube.com/embed/${ID}?start=7&autoplay=0&mute=1`))).toBe(nocookie("&start=7"));
    expect(playerSrc(embed(`https://www.youtube-nocookie.com/embed/${ID}`))).toBe(nocookie());
    expect(playerSrc(embed(`https://www.youtube.com/watch?v=${ID}#t=45`))).toBe(nocookie("&start=45"));
    // Single quotes are a quoted value too.
    expect(playerSrc(`[embed url='https://youtu.be/${ID}' title='Video' /]`)).toBe(nocookie());
  });

  it("refuses anything that is not an https YouTube video with a well-formed id", () => {
    for (const url of [
      `http://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}x`,
      `https://www.youtube.com/watch?v=dQw4w9WgXc`,
      `https://www.youtube.com/watch?v=dQw4w9WgX%22`,
      `https://www.youtube.com.evil.example/watch?v=${ID}`,
      `https://evil.example/watch?v=${ID}`,
      `https://www.youtube.com:8443/watch?v=${ID}`,
      `https://www.youtube.com/playlist?list=${ID}`,
    ]) {
      const { container, unmount } = bubble(`[embed url="${url}" title="Video" /]`);
      expect(screen.queryByTestId("chat-embed-youtube"), url).toBeNull();
      expect(container.querySelector("iframe"), url).toBeNull();
      expect(container.textContent, url).not.toContain("[embed");
      unmount();
    }
  });
});

describe("embed shortcode: other targets", () => {
  it("draws a hosted Canvas document as a titled card, never a frame", () => {
    for (const text of [
      `[embed ref="cv_123" title="Status" height="320" /]`,
      `[embed url="/__openclaw__/canvas/documents/cv_123/index.html" title="Status" /]`,
    ]) {
      const { container, unmount } = bubble(text);
      expect(screen.getByTestId("chat-embed-hosted")).toHaveTextContent("Status");
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.textContent).not.toContain("[embed");
      unmount();
    }
    bubble(`[embed ref="cv_9" /]`);
    expect(screen.getByTestId("chat-embed-hosted")).toHaveTextContent("Embedded content");
  });

  it("shows another https page as a plain link with its title, no frame", () => {
    const { container } = bubble(`See [embed url="https://example.com/status?x=1" title="Status page" /] for more.`);
    const link = screen.getByRole("link", { name: "Status page" });
    expect(link).toHaveAttribute("href", "https://example.com/status?x=1");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("See");
    expect(container.textContent).toContain("for more.");
    expect(container.textContent).not.toContain("[embed");
  });

  it("prints only the title for a hostile or malformed URL", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://example.com/page",
      "https://user:pass@example.com/",
      "not a url",
      "//example.com/page",
    ]) {
      const { container, unmount } = bubble(`[embed url="${url}" title="Click me" /]`);
      expect(container.textContent, url).toBe("Click me");
      expect(container.querySelector("a, iframe, img, script"), url).toBeNull();
      unmount();
    }
  });

  it("never turns the title into markup", () => {
    const { container } = bubble(`[embed url="https://example.com/" title="<img src=x onerror=alert(1)>" /]`);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("embed shortcode: where it is not one", () => {
  it("stays literal inside a code fence and inline code", () => {
    const shortcode = `[embed url="https://www.youtube.com/watch?v=${ID}" title="Trailer" /]`;
    const { container } = bubble(`Write it like this:\n\`\`\`\n${shortcode}\n\`\`\`\nor inline: \`${shortcode}\``);
    expect(container.querySelector("pre")?.textContent).toBe(shortcode);
    expect(container.querySelector("code")?.textContent).toBe(shortcode);
    expect(screen.queryByTestId("chat-embed-youtube")).toBeNull();
  });

  it("keeps text that only looks like the start of one", () => {
    const { container } = bubble("Use the [embed shortcode] to show things.\nMore text.");
    expect(container.textContent).toContain("Use the [embed shortcode] to show things.");
    expect(container.textContent).toContain("More text.");
  });

  it("draws two in a row and the prose between them", () => {
    bubble(`[embed url="https://youtu.be/${ID}" title="One" /] and [embed url="https://youtu.be/aaaaaaaaaaa" title="Two" /]`);
    expect(screen.getAllByTestId("chat-embed-youtube")).toHaveLength(2);
    expect(screen.getByTestId("bubble").textContent).toContain("and");
  });
});

describe("embed shortcode: while streaming", () => {
  it("never flashes a half-written shortcode", () => {
    const full = `Here you go: [embed url="https://www.youtube.com/watch?v=${ID}" title="Trailer" /]`;
    // Every prefix the stream can deliver, from "[e" to the closing "/".
    for (let end = full.indexOf("[e") + 2; end < full.length; end++) {
      const { container, unmount } = bubble(full.slice(0, end), true);
      expect(container.textContent, full.slice(0, end)).toBe("Here you go:");
      unmount();
    }
    bubble(full, true);
    expect(screen.getByTestId("chat-embed-youtube")).toBeInTheDocument();
  });

  it("never cuts the end of a settled reply", () => {
    const { container } = bubble("To show a video, type [embed");
    expect(container.textContent).toBe("To show a video, type [embed");
  });
});

describe("embed shortcode: inside other blocks", () => {
  const shortcode = `[embed url="https://youtu.be/${ID}" title="Demo" /]`;

  it("lifts it out of a list, a table and a <details> without leaving it raw", () => {
    for (const text of [
      `- Intro\n- ${shortcode}\n- Outro`,
      `1. Watch: ${shortcode}`,
      `| a | b |\n|---|---|\n| 1 | ${shortcode} |`,
      `${shortcode} <details><summary>More</summary>body</details>`,
      `<details><summary>More</summary>body</details> ${shortcode}`,
      `Press \` to start ${shortcode}`,
    ]) {
      const { container, unmount } = bubble(text);
      expect(screen.getAllByTestId("chat-embed-youtube"), text).toHaveLength(1);
      expect(container.textContent, text).not.toContain("[embed");
      expect(container.textContent, text).not.toContain("/]");
      unmount();
    }
    const { container } = bubble(`- Intro\n- ${shortcode}\n- Outro`);
    expect(container.textContent).toContain("Intro");
    expect(container.textContent).toContain("Outro");
    expect(container.textContent).not.toMatch(/^-|\n-/);
  });

  it("draws one inside a disclosure once it is opened", () => {
    bubble(`<details><summary>Video</summary>\n${shortcode}\n</details>`);
    fireEvent.click(screen.getByTestId("chat-markdown-details-toggle"));
    expect(screen.getByTestId("chat-markdown-details-body").textContent).not.toContain("[embed");
    expect(screen.getByTestId("chat-embed-youtube")).toBeInTheDocument();
  });

  it("closes over a title that holds brackets", () => {
    const { container } = bubble(`[embed url="https://youtu.be/${ID}" title="Trailer [HD]" /]`);
    expect(screen.getByTestId("chat-embed-youtube")).toHaveTextContent("Trailer [HD]");
    expect(container.textContent).not.toContain("[embed");
  });

  it("leaves renderText callers outside the chat as they were", () => {
    const { container } = render(<div>{renderText(shortcode)}</div>);
    expect(container.textContent).toBe(shortcode);
  });

  it("stays fast on a hostile reply", () => {
    const hostile = `[embed${" ".repeat(50_000)}x [embed url="${"a".repeat(50_000)}`;
    const t0 = performance.now();
    bubble(hostile, true);
    speechTextFor(hostile);
    plainTextForLabel(hostile);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("embed shortcode: what is read aloud", () => {
  const reply = `Here is the trailer: [embed url="https://www.youtube.com/watch?v=${ID}" title="Trailer" /] Enjoy.`;

  it("leaves only the title in the accessible label", () => {
    expect(plainTextForLabel(reply)).toBe("Here is the trailer: Trailer Enjoy.");
    expect(plainTextForLabel(`Done. [embed ref="cv_1" /]`)).toBe("Done.");
  });

  it("leaves only the title in what the voice says", () => {
    expect(speechTextFor(reply)).toBe("Here is the trailer: Trailer Enjoy.");
    expect(speechTextFor(`Done.\n[embed ref="cv_1" height="320" /]`)).toBe("Done.");
    expect(shortSpeechTextFor(reply)).not.toContain("embed");
  });
});
