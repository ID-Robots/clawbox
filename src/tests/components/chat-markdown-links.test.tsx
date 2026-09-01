import { describe, expect, it } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import { renderText } from "@/lib/chat-markdown";

/**
 * Bare URLs in the mascot chat must be clickable.
 *
 * `[label](url)` was already rendered as an anchor, but a PASTED link was not —
 * and pasted is how links actually arrive here: the agent hands over tunnel
 * URLs, PR links and docs as plain text. The owner had to select and copy them
 * by hand.
 *
 * The other half of this is what must NOT become a link. Chat is full of
 * filenames, so `page.tsx` and `config.json` stay text; only http/https and
 * `www.` hosts are linked.
 */
function draw(text: string) {
  return render(<div data-testid="bubble">{renderText(text)}</div>);
}

function links(container: HTMLElement) {
  return [...container.querySelectorAll("a")].map((a) => ({
    href: a.getAttribute("href"),
    text: a.textContent,
  }));
}

describe("bare URLs in chat text", () => {
  it("links a pasted https URL", () => {
    const { container } = draw("Tunnel is up: https://foo-bar.trycloudflare.com now");
    expect(links(container)).toEqual([
      { href: "https://foo-bar.trycloudflare.com", text: "https://foo-bar.trycloudflare.com" },
    ]);
    // The surrounding sentence survives — linkifying must not eat text.
    expect(container.textContent).toContain("Tunnel is up:");
    expect(container.textContent).toContain("now");
  });

  it("opens in a new tab without handing the opener over", () => {
    const { container } = draw("see https://example.com");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("gives a www host a scheme, since href without one is a relative path", () => {
    const { container } = draw("docs at www.clawbox.com today");
    expect(links(container)).toEqual([
      { href: "https://www.clawbox.com", text: "www.clawbox.com" },
    ]);
  });

  it("leaves the sentence's full stop out of the link", () => {
    const { container } = draw("Open https://example.com/x.");
    expect(links(container)[0].href).toBe("https://example.com/x");
    expect(container.textContent).toContain("https://example.com/x.");
  });

  it("keeps a balanced bracket that is part of the path", () => {
    const { container } = draw("https://en.wikipedia.org/wiki/Foo_(bar) ok");
    expect(links(container)[0].href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("does not linkify filenames, which chat is full of", () => {
    const { container } = draw("edit page.tsx and config.json, then run index.js");
    expect(links(container)).toEqual([]);
  });

  it("does not linkify a javascript: URL", () => {
    // eslint-disable-next-line no-script-url
    const { container } = draw("try javascript:alert(1) here");
    expect(links(container)).toEqual([]);
  });

  it("leaves a markdown link alone rather than double-wrapping it", () => {
    const { container } = draw("see [the docs](https://example.com/docs) please");
    expect(links(container)).toEqual([
      { href: "https://example.com/docs", text: "the docs" },
    ]);
  });

  it("does not turn a URL inside a code span into a link", () => {
    const { container } = draw("run `curl https://example.com` first");
    expect(links(container)).toEqual([]);
  });

  it("links each of several URLs in one line", () => {
    const { container } = draw("https://a.example.com and https://b.example.com");
    expect(links(container).map((l) => l.href)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});
