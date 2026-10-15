import { describe, expect, it } from "vitest";
import { sameSpokenWords,
  SHORT_SPEECH_MAX_CHARS,
  SHORT_SPEECH_MAX_SENTENCES,
  shortSpeechTextFor,
  shortSpeechTextFromStream,
} from "@/lib/short-speech-text";
import { speechTextFor } from "@/lib/speech-text";

/**
 * What a reply says out loud with Settings → Voice → "Short spoken answers"
 * on: the answer, in one to three sentences, picked out of the reply itself —
 * and, while the reply is still streaming, the same words as soon as nothing
 * still to come could change them.
 */

const PROSE =
  "The gateway restarted cleanly and is answering again. I checked the logs and the crash came from a full disk. "
  + "I cleared 4 GB of old snapshots, so it should not happen again soon. If it does, the nightly cleanup can be made "
  + "more aggressive. Let me know if you want that.";

const MARKDOWN = [
  "## Disk check",
  "",
  "Your **SSD** is at *91%* — see [the storage page](https://clawbox.local/storage) for details. Most of it is `node_modules` in old projects.",
  "",
  "| Folder | Size |",
  "|---|---|",
  "| ~/Projects | 40 GB |",
  "",
  "- Delete old builds",
  "- Empty the trash",
  "",
  "```bash",
  "du -sh ~/Projects/*",
  "```",
  "",
  "That frees about 12 GB.",
].join("\n");

const OPENS_WITH_CODE = [
  "Here is the fix:",
  "",
  "```ts",
  "const timeout = 30_000;",
  "```",
  "",
  "This raises the timeout from 5 to 30 seconds, which stops the crash. Restart the app to pick it up.",
].join("\n");

const LONG_FIRST_SENTENCE =
  "The update touches the gateway, the voice service, the mail bridge, the coding agent, the backup timer, "
  + "the camera relay, the browser sandbox, the file sharing page, the update checker, the setup wizard, "
  + "the remote desktop, the network watchdog, the language packs and the onboarding tips, so expect a restart "
  + "or two while it settles in. Then it is done.";

const DECORATED =
  "[[reply_to_current]] ✅ Done — your photo is saved as `beach_day.png` in Pictures (see https://clawbox.local/files/Pictures).\n"
  + "MEDIA:/home/clawbox/Pictures/beach_day.png\n"
  + "Want me to share it with __Maria__?";

const BULLETS = [
  "Three things need attention:",
  "",
  "- The backup drive is almost full",
  "- Two updates are waiting",
  "- The camera is offline",
  "- Mail sync failed twice",
].join("\n");

const CJK = "构建已经完成。所有测试都通过了！下一步是部署到设备上。部署大约需要五分钟。";

const SECTIONS = "Yes, the update worked.\n\n## What changed\n\nThe gateway moved to a new port. The old port is closed.";

const FIXTURES = { PROSE, MARKDOWN, OPENS_WITH_CODE, LONG_FIRST_SENTENCE, DECORATED, BULLETS, CJK, SECTIONS };

describe("shortSpeechTextFor", () => {
  it("says the first three sentences of a long answer", () => {
    expect(shortSpeechTextFor(PROSE)).toBe(
      "The gateway restarted cleanly and is answering again. I checked the logs and the crash came from a full disk. "
      + "I cleared 4 GB of old snapshots, so it should not happen again soon.",
    );
  });

  it("says a short reply whole", () => {
    expect(shortSpeechTextFor("Done. The light is off.")).toBe("Done. The light is off.");
    expect(shortSpeechTextFor("It is 21 degrees")).toBe("It is 21 degrees.");
  });

  it("stops at the first table, code block or heading after the answer, and never reads one", () => {
    expect(shortSpeechTextFor(MARKDOWN)).toBe(
      "Your SSD is at 91% — see the storage page for details. Most of it is node modules in old projects.",
    );
    expect(shortSpeechTextFor(SECTIONS)).toBe("Yes, the update worked.");
    expect(shortSpeechTextFor("I fixed it. Here is the diff:\n```diff\n- a\n+ b\n```\nAnything else?")).toBe("I fixed it.");
  });

  it("skips a block the reply opens with, and the line that introduced it", () => {
    expect(shortSpeechTextFor(OPENS_WITH_CODE)).toBe(
      "This raises the timeout from 5 to 30 seconds, which stops the crash. Restart the app to pick it up.",
    );
    expect(shortSpeechTextFor("## Summary\nThe build passed. Two tests were flaky.")).toBe("The build passed. Two tests were flaky.");
  });

  it("says the introduction when the rest of the reply is code, and nothing for code alone", () => {
    expect(shortSpeechTextFor("Run this:\n\n```bash\nsudo systemctl restart clawbox-setup\n```")).toBe("Run this.");
    expect(shortSpeechTextFor("```\nls -la\n```")).toBe("");
    expect(shortSpeechTextFor("```\nunclosed code")).toBe("");
    expect(shortSpeechTextFor("")).toBe("");
    expect(shortSpeechTextFor("MEDIA:/tmp/pic.png")).toBe("");
  });

  it("drops what cannot be said: reply tags, pictographs, URLs, MEDIA lines, emphasis", () => {
    expect(shortSpeechTextFor(DECORATED)).toBe(
      "Done — your photo is saved as beach day.png in Pictures. Want me to share it with Maria?",
    );
  });

  it("makes each bullet a sentence, with a stop the voice can fall on", () => {
    expect(shortSpeechTextFor(BULLETS)).toBe(
      "Three things need attention: The backup drive is almost full. Two updates are waiting.",
    );
  });

  it("leaves out a last sentence that only introduced what is not said", () => {
    expect(shortSpeechTextFor("I checked the logs. The service crashed at 3 am. Here is the trace:\n\n- one\n- two"))
      .toBe("I checked the logs. The service crashed at 3 am.");
  });

  it("joins a hard-wrapped sentence back together", () => {
    expect(shortSpeechTextFor("The nightly backup ran at 02:00 and copied\nall 14 projects to the external drive.\nIt took six minutes."))
      .toBe("The nightly backup ran at 02:00 and copied all 14 projects to the external drive. It took six minutes.");
  });

  it("does not end a sentence at an abbreviation or a decimal point", () => {
    expect(shortSpeechTextFor("Use a short name, e.g. kitchen or office. Version 2.1 handles it. Pi is about 3.14 here. Dr. Lee agreed."))
      .toBe("Use a short name, e.g. kitchen or office. Version 2.1 handles it. Pi is about 3.14 here.");
    expect(shortSpeechTextFor("Dr. Lee agreed. Ship it. Done. Extra.")).toBe("Dr. Lee agreed. Ship it. Done.");
  });

  it("ends sentences at CJK stops", () => {
    expect(shortSpeechTextFor(CJK)).toBe("构建已经完成。 所有测试都通过了！ 下一步是部署到设备上。");
  });

  it("stops before a sentence that would not fit", () => {
    const first = `The first sentence runs on for a while ${"and on ".repeat(10)}until here.`;
    const second = `The second one is just as long ${"and long ".repeat(9)}until there.`;
    const third = `The third would push it over ${"the top ".repeat(8)}by far.`;
    expect(first.length + second.length).toBeLessThan(SHORT_SPEECH_MAX_CHARS);
    expect(first.length + second.length + third.length).toBeGreaterThan(SHORT_SPEECH_MAX_CHARS);
    expect(shortSpeechTextFor(`${first} ${second} ${third}`)).toBe(`${first} ${second}`);
  });

  it("cuts a first sentence too long to say whole at a clause", () => {
    const spoken = shortSpeechTextFor(LONG_FIRST_SENTENCE);
    expect(spoken.length).toBeLessThanOrEqual(SHORT_SPEECH_MAX_CHARS);
    expect(spoken.endsWith("the onboarding tips.")).toBe(true);
    expect(LONG_FIRST_SENTENCE.startsWith(`${spoken.slice(0, -1)},`)).toBe(true);
    // No clause and no space at all: a hard cut, still a stop.
    const unbroken = shortSpeechTextFor("a".repeat(1000));
    expect(unbroken).toBe(`${"a".repeat(SHORT_SPEECH_MAX_CHARS - 1)}.`);
  });

  it("never says more than the cap or the sentence count, whatever the reply", () => {
    for (const [name, reply] of Object.entries({ ...FIXTURES, long: PROSE.repeat(20), wide: "word ".repeat(400) })) {
      const spoken = shortSpeechTextFor(reply);
      expect(spoken.length, name).toBeLessThanOrEqual(SHORT_SPEECH_MAX_CHARS);
      expect(spoken.split(/(?<=[.!?。！？]) /).length, name).toBeLessThanOrEqual(SHORT_SPEECH_MAX_SENTENCES);
      expect(spoken, name).not.toMatch(/https?:|\*|`|\[|\]|\n/);
    }
  });

  it("passes through the speak route's own speechTextFor unchanged", () => {
    for (const [name, reply] of Object.entries(FIXTURES)) {
      const spoken = shortSpeechTextFor(reply);
      expect(speechTextFor(spoken), name).toBe(spoken);
    }
  });
});

describe("shortSpeechTextFromStream", () => {
  it("answers nothing until the answer's sentences are all in, then exactly them", () => {
    const thirdEnds = PROSE.indexOf("soon.") + "soon.".length;
    expect(shortSpeechTextFromStream(PROSE.slice(0, thirdEnds))).toBeNull();
    // One more sentence has started: the third cannot grow any more.
    expect(shortSpeechTextFromStream(PROSE.slice(0, thirdEnds + 2))).toBe(shortSpeechTextFor(PROSE));
  });

  it("settles the moment a table, code block or heading starts after the answer", () => {
    const table = MARKDOWN.indexOf("| Folder");
    expect(shortSpeechTextFromStream(MARKDOWN.slice(0, table))).toBeNull();
    expect(shortSpeechTextFromStream(MARKDOWN.slice(0, table + 1))).toBe(shortSpeechTextFor(MARKDOWN));
    // "##" may yet be "##42 …"; "## " is a heading.
    expect(shortSpeechTextFromStream("Yes, the update worked.\n\n##")).toBeNull();
    expect(shortSpeechTextFromStream("Yes, the update worked.\n\n## ")).toBe("Yes, the update worked.");
    expect(shortSpeechTextFromStream("I fixed it. Here is the diff:\n```")).toBe("I fixed it.");
    expect(shortSpeechTextFromStream("I fixed it. Here is the diff:\n``")).toBeNull();
  });

  it("settles mid-sentence once the first sentence is surely too long to say whole", () => {
    expect(shortSpeechTextFromStream(LONG_FIRST_SENTENCE.slice(0, 310))).toBeNull();
    expect(shortSpeechTextFromStream(LONG_FIRST_SENTENCE.slice(0, 330))).toBe(shortSpeechTextFor(LONG_FIRST_SENTENCE));
  });

  it("waits out a code block the reply opens with, and a reply too short to settle", () => {
    expect(shortSpeechTextFromStream("Here is the fix:\n\n```ts\nconst a = 1;\nconst b = 2;")).toBeNull();
    expect(shortSpeechTextFromStream("Done. The light is off.")).toBeNull();
    expect(shortSpeechTextFromStream("")).toBeNull();
  });

  it("does not trust a link or a mid-line code block still being written", () => {
    expect(shortSpeechTextFromStream("One. Two. See [the docs")).toBeNull();
    expect(shortSpeechTextFromStream("One. Two. See [the docs]")).toBeNull();
    expect(shortSpeechTextFromStream("One. Two. See [the docs](https://exa")).toBeNull();
    expect(shortSpeechTextFromStream("One. Two. See [the docs](https://example.com) now. Then")).toBe("One. Two. See the docs now.");
    // "```" can take everything up to its partner away; a single backtick only itself.
    expect(shortSpeechTextFromStream("One. Two. Run ```npm test. Then")).toBeNull();
    expect(shortSpeechTextFromStream("One. Two. Run `npm test. Then")).toBe("One. Two. Run npm test.");
    expect(shortSpeechTextFromStream("One. Two. Three. Four")).toBe("One. Two. Three.");
  });

  it("never answers anything but what the finished reply will say", () => {
    for (const [name, reply] of Object.entries(FIXTURES)) {
      const final = shortSpeechTextFor(reply);
      let settledAt = -1;
      for (let end = 0; end <= reply.length; end++) {
        const early = shortSpeechTextFromStream(reply.slice(0, end));
        if (early === null) continue;
        expect(early, `${name} at ${end}`).toBe(final);
        if (settledAt < 0) settledAt = end;
      }
      // Each long reply settles before it has finished streaming.
      if (["PROSE", "MARKDOWN", "LONG_FIRST_SENTENCE", "BULLETS", "CJK", "SECTIONS"].includes(name)) {
        expect(settledAt, name).toBeGreaterThan(0);
        expect(settledAt, name).toBeLessThan(reply.length);
      }
    }
  });

  it("holds to the finished answer over replies cut and reassembled at every length", () => {
    // Every fixture's tail glued after every other's head: blocks, bullets
    // and links arriving at every point of a sentence.
    const replies = Object.values(FIXTURES);
    for (const head of replies) {
      for (const tail of replies) {
        for (const cut of [7, 23, 61, 140]) {
          const reply = `${head.slice(0, cut)}${tail}`;
          const final = shortSpeechTextFor(reply);
          for (let end = 0; end <= reply.length; end += 3) {
            const early = shortSpeechTextFromStream(reply.slice(0, end));
            if (early !== null) expect(early, `${JSON.stringify(reply.slice(0, end))}`).toBe(final);
          }
        }
      }
    }
  });
});

describe("sameSpokenWords", () => {
  it("treats spacing and line breaks as the same words", () => {
    expect(sameSpokenWords("First message.\nSecond message.", "First message. Second message.")).toBe(true);
  });
  it("tells different words apart", () => {
    expect(sameSpokenWords("Yes, it ran.", "No, it failed.")).toBe(false);
    expect(sameSpokenWords("Short. Two. Three.", "Short. Two. Three. Four.")).toBe(false);
  });
});
