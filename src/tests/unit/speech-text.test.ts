import { describe, expect, it } from "vitest";
import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";

/**
 * What a spoken reply says: the words, not the markup, and not more than a
 * voice note's worth.
 */
describe("speechTextFor", () => {
  it("lifts the words out of Markdown", () => {
    const md = "## Done\n\n- **Built** the app\n- See [the docs](https://example.com/x) and `npm test`\n\n```js\nconsole.log(1)\n```\n\nMEDIA: /tmp/pic.png\n> quoted";
    expect(speechTextFor(md)).toBe("Done\nBuilt the app\nSee the docs and npm test\nquoted");
  });

  it("drops bare URLs", () => {
    expect(speechTextFor("go to https://clawbox.com/x now ok")).toBe("go to now ok");
  });

  it("caps at a sentence end", () => {
    const sentence = "This is a sentence that ends properly. ";
    const long = sentence.repeat(200);
    const spoken = speechTextFor(long);
    expect(spoken.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
    expect(spoken.endsWith(".")).toBe(true);
  });

  it("answers nothing for a reply with nothing to say", () => {
    expect(speechTextFor("MEDIA: /a.png\n```\ncode\n```")).toBe("");
  });
});
