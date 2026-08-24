import { describe, expect, it } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import { renderText } from "@/lib/chat-markdown";

/**
 * `renderText` must never lose text.
 *
 * The bug this file locks out: the renderer split a reply on blank lines and
 * matched `/^##\s+(.+)/` against each chunk, returning ONLY the heading when it
 * matched. `.` does not match a newline, so a heading followed by its body on
 * the very next line — the normal shape a model emits —
 *
 *     ## Hardware
 *     | **CPU** | 6x Cortex-A78AE |
 *
 * reached the bubble as the single word "Hardware". Observed live on the owner's
 * Hermes box: the transcript row held the complete 1429-character reply while
 * the bubble showed five headings and the two paragraphs that happened to sit
 * outside any section. The server and streaming sides were verified correct.
 *
 * Tables were the second half of the same hole — `| a | b |` fell through to the
 * paragraph branch and was drawn as raw pipes, and the device model emits tables
 * routinely.
 */

function draw(text: string) {
  return render(<div data-testid="bubble">{renderText(text)}</div>);
}

describe("renderText block parsing", () => {
  describe("the regression: a heading never swallows what follows it", () => {
    it("keeps the body when heading and body are one newline apart", () => {
      // The exact shape that was lost. Before this fix the assertion below
      // failed on every line except the heading itself.
      const { getByTestId } = draw(
        "## Hardware\nThe board reports 6 CPU cores.\nMemory is shared with the GPU.",
      );
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("Hardware");
      expect(text).toContain("The board reports 6 CPU cores.");
      expect(text).toContain("Memory is shared with the GPU.");
    });

    it("keeps the body under a ### heading too", () => {
      const { getByTestId } = draw("### Storage\n116 GB free of 235 GB.");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("Storage");
      expect(text).toContain("116 GB free of 235 GB.");
    });

    it("ends the heading at its own line, so the body is a separate element", () => {
      const { container } = draw("## Hardware\nSix cores.");
      const heading = container.querySelector("h2");
      expect(heading?.textContent).toBe("Hardware");
      // The body must NOT have been absorbed into the heading element.
      expect(heading?.textContent).not.toContain("Six cores.");
      expect(container.textContent).toContain("Six cores.");
    });

    it("still separates a heading from a body a blank line away", () => {
      const { getByTestId } = draw("## Hardware\n\nSix cores.");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("Hardware");
      expect(text).toContain("Six cores.");
    });
  });

  describe("heading levels", () => {
    it("renders levels 1 to 6 and keeps every title", () => {
      const { container } = draw("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six");
      // Levels 1-2 keep the h2 styling the bubble already used, 3+ the h3 one.
      expect([...container.querySelectorAll("h2")].map((el) => el.textContent)).toEqual(["One", "Two"]);
      expect([...container.querySelectorAll("h3")].map((el) => el.textContent)).toEqual([
        "Three",
        "Four",
        "Five",
        "Six",
      ]);
    });

    it("does not treat a hash without a space as a heading", () => {
      const { container } = draw("#nothashtag");
      expect(container.querySelector("h2")).toBeNull();
      expect(container.textContent).toContain("#nothashtag");
    });

    it("gives the first block no top margin and later ones their spacing", () => {
      const { container } = draw("## First\n## Second");
      const headings = container.querySelectorAll("h2");
      expect(headings[0].className).not.toContain("mt-");
      expect(headings[1].className).toContain("mt-2.5");
    });
  });

  describe("tables", () => {
    it("renders a divider table with a header row", () => {
      const { container } = draw(
        "| Part | Value |\n| --- | --- |\n| CPU | 6x Cortex-A78AE |\n| RAM | 7.6 GB |",
      );
      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      expect([...container.querySelectorAll("th")].map((el) => el.textContent)).toEqual([
        "Part",
        "Value",
      ]);
      const rows = [...container.querySelectorAll("tbody tr")].map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent),
      );
      expect(rows).toEqual([
        ["CPU", "6x Cortex-A78AE"],
        ["RAM", "7.6 GB"],
      ]);
      // The divider is layout, not data — it must not become a row.
      expect(container.textContent).not.toContain("---");
    });

    it("renders a table with no divider as all-body rows", () => {
      const { container } = draw("| CPU | 6x Cortex-A78AE |\n| RAM | 7.6 GB |");
      expect(container.querySelector("table")).not.toBeNull();
      expect(container.querySelectorAll("th")).toHaveLength(0);
      expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
      // The pipes themselves are gone; the values are not.
      expect(container.textContent).not.toContain("|");
      expect(container.textContent).toContain("6x Cortex-A78AE");
      expect(container.textContent).toContain("7.6 GB");
    });

    it("applies inline formatting inside cells", () => {
      const { container } = draw("| **CPU** | `nproc` says 6 |\n| *RAM* | [docs](https://clawbox.com/d) |");
      expect(container.querySelector("td strong")?.textContent).toBe("CPU");
      expect(container.querySelector("td code")?.textContent).toBe("nproc");
      expect(container.querySelector("td em")?.textContent).toBe("RAM");
      const link = container.querySelector("td a");
      expect(link?.textContent).toBe("docs");
      expect(link?.getAttribute("href")).toBe("https://clawbox.com/d");
    });

    it("does not split a cell on a pipe inside code or an escaped pipe", () => {
      const { container } = draw("| pipe | `a | b` |\n| esc | x \\| y |");
      const rows = [...container.querySelectorAll("tbody tr")].map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent),
      );
      expect(rows).toEqual([
        ["pipe", "a | b"],
        ["esc", "x | y"],
      ]);
    });

    it("scrolls a wide table inside the bubble instead of widening it", () => {
      // The bubble is capped at 85% of the thread; a table that sets its own
      // width would push the whole popup out of shape.
      const { container } = draw("| a | b |");
      const wrapper = container.querySelector("table")?.parentElement;
      expect(wrapper?.className).toContain("overflow-x-auto");
      expect(wrapper?.className).toContain("max-w-full");
    });

    it("keeps a lone divider-looking line as text rather than an empty table", () => {
      const { container } = draw("|---|---|");
      expect(container.querySelector("table")).toBeNull();
      expect(container.textContent).toContain("|---|---|");
    });

    it("returns to prose after the table ends", () => {
      const { container } = draw("| CPU | 6 |\nThat is the whole board.");
      expect(container.querySelector("table")).not.toBeNull();
      expect(container.textContent).toContain("That is the whole board.");
    });
  });

  describe("lists", () => {
    it("bullets -, * and + items", () => {
      const { getByTestId } = draw("- first\n* second\n+ third");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("first");
      expect(text).toContain("second");
      expect(text).toContain("third");
      expect(text.match(/•/g)).toHaveLength(3);
    });

    it("shows the number of an ordered item", () => {
      const { getByTestId } = draw("1. wake\n2. build\n3. restart");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("1.");
      expect(text).toContain("2.");
      expect(text).toContain("3.");
      expect(text).toContain("wake");
      expect(text).toContain("restart");
      expect(text).not.toContain("•");
    });

    it("accepts the 1) form as well", () => {
      const { getByTestId } = draw("1) wake\n2) build");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("1.");
      expect(text).toContain("wake");
      expect(text).toContain("build");
    });

    it("keeps a list attached to the heading above it", () => {
      const { getByTestId } = draw("## Steps\n- pull\n- build");
      const text = getByTestId("bubble").textContent ?? "";
      expect(text).toContain("Steps");
      expect(text).toContain("pull");
      expect(text).toContain("build");
    });

    it("does not mistake emphasis at the start of a line for a bullet", () => {
      const { container } = draw("*emphatic* opening");
      expect(container.textContent).not.toContain("•");
      expect(container.querySelector("em")?.textContent).toBe("emphatic");
    });
  });

  describe("fenced code", () => {
    it("keeps a blank line inside the fence", () => {
      // Splitting on blank lines first tore this block in two and rendered the
      // halves as prose with stray backticks.
      const { container } = draw("before\n```bash\nls -la\n\necho done\n```\nafter");
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toBe("ls -la\n\necho done");
      expect(container.textContent).toContain("before");
      expect(container.textContent).toContain("after");
      expect(container.textContent).not.toContain("```");
    });

    it("does not treat markdown inside a fence as markup", () => {
      const { container } = draw("```\n## not a heading\n- not a bullet\n| not | a table |\n```");
      expect(container.querySelector("h2")).toBeNull();
      expect(container.querySelector("table")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toBe(
        "## not a heading\n- not a bullet\n| not | a table |",
      );
    });

    it("renders an unterminated fence as code rather than losing it", () => {
      // Mid-stream the closing fence has not arrived yet.
      const { container } = draw("```bash\nbun run build");
      expect(container.querySelector("pre")?.textContent).toBe("bun run build");
    });
  });

  describe("paragraphs", () => {
    it("keeps single newlines inside a paragraph as line breaks", () => {
      const { container } = draw("one\ntwo");
      expect(container.querySelectorAll("br")).toHaveLength(1);
      expect(container.textContent).toContain("one");
      expect(container.textContent).toContain("two");
    });

    it("separates paragraphs split by a blank line", () => {
      const { container } = draw("first para\n\nsecond para");
      expect(container.textContent).toContain("first para");
      expect(container.textContent).toContain("second para");
    });

    it("renders empty input as nothing", () => {
      const { getByTestId } = draw("");
      expect(getByTestId("bubble").textContent).toBe("");
    });
  });
});

/**
 * The shape of the reply that exposed the bug: sections whose bodies sit one
 * newline under their heading, tables, and a bullet list.
 */
const DEVICE_REPLY = [
  "Here is the full status of your ClawBox.",
  "",
  "## Hardware",
  "| Part | Value |",
  "| --- | --- |",
  "| CPU | 6x Cortex-A78AE |",
  "| RAM | 7.6 GB |",
  "| Disk | 235 GB |",
  "",
  "## Services",
  "The gateway and the dashboard are both up.",
  "- clawbox-setup is active",
  "- hermes-gateway is active",
  "- nothing has failed since boot",
  "",
  "### Restarting",
  "Run the command below if you need to bounce the dashboard.",
  "```bash",
  "sudo systemctl restart clawbox-setup",
  "",
  "systemctl status clawbox-setup",
  "```",
  "",
  "1. check the port responds",
  "2. reload the browser tab",
  "",
  "Everything else looks healthy.",
].join("\n");

/** Words the source really contains, with the markup characters removed. */
function contentWords(source: string): string[] {
  return source
    .replace(/```\w*/g, " ")
    .replace(/[#*`|_]/g, " ")
    .replace(/^\s*[-+]\s/gm, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && /[A-Za-z0-9]/.test(word) && !/^-+$/.test(word));
}

describe("renderText on a whole device reply", () => {
  it("drops not one word of it", () => {
    // The blunt version of the regression: whatever the model wrote, the reader
    // sees. Before the fix this failed on roughly half the reply.
    const { getByTestId } = draw(DEVICE_REPLY);
    const shown = getByTestId("bubble").textContent ?? "";
    const missing = contentWords(DEVICE_REPLY).filter((word) => !shown.includes(word));
    expect(missing).toEqual([]);
  });

  it("gives each part the right element", () => {
    const { container } = draw(DEVICE_REPLY);
    expect([...container.querySelectorAll("h2")].map((el) => el.textContent)).toEqual([
      "Hardware",
      "Services",
    ]);
    expect([...container.querySelectorAll("h3")].map((el) => el.textContent)).toEqual([
      "Restarting",
    ]);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.querySelector("pre")?.textContent).toContain("systemctl status clawbox-setup");
    // The bullet list and the numbered list are two separate runs.
    expect(container.textContent).toContain("•");
    expect(container.textContent).toContain("1.");
  });
});
