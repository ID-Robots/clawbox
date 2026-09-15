// @vitest-environment jsdom
/**
 * The chat's coding run card has one button, View, and it opens the run's
 * page in a NORMAL window.
 *
 * It asked for `{ maximize: true }` once: every press threw the Coding Agent
 * window to full screen, over a size and place the owner had chosen, and a
 * window already up lost both. The maximize CAPABILITY stays in ui-events —
 * the desktop's finish card or a future caller may want it — but the chat
 * must not ask for it. Two pins: the call site in ChatPopup, and the event
 * `dispatchOpenCodingRun` sends when nothing is asked, which is what the
 * desktop reads.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dispatchOpenCodingRun,
  OPEN_APP_EVENT,
  OPEN_CODING_RUN_EVENT,
  takePendingCodingRun,
  type OpenAppDetail,
} from "@/lib/ui-events";

const CHAT_POPUP = fs.readFileSync(path.join(process.cwd(), "src/components/ChatPopup.tsx"), "utf-8");

describe("the chat's View button on a coding run card", () => {
  it("hands the run over without asking for a maximize", () => {
    // The one call site: the card's onOpen. A run id and nothing else.
    expect(CHAT_POPUP).toMatch(/onOpen=\{\(\) => dispatchOpenCodingRun\(run\.id\)\}/);
    // And no other chat-side caller sneaks the option back in.
    const calls = CHAT_POPUP.match(/dispatchOpenCodingRun\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/maximize/);
  });

  it("opens the Coding Agent app on the run in a plain window when nothing is asked", () => {
    const opens: OpenAppDetail[] = [];
    const runs: unknown[] = [];
    const onOpen = (e: Event) => opens.push((e as CustomEvent<OpenAppDetail>).detail);
    const onRun = (e: Event) => runs.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    window.addEventListener(OPEN_CODING_RUN_EVENT, onRun);
    try {
      dispatchOpenCodingRun("run-7");
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
      window.removeEventListener(OPEN_CODING_RUN_EVENT, onRun);
    }
    // `toEqual` on the whole detail: a `maximize: false` key would be a
    // different contract from no key, and the desktop reads the key's presence.
    expect(opens).toEqual([{ appId: "coding" }]);
    expect(runs).toEqual([{ runId: "run-7" }]);
    // The cold-open handoff still rides along, taken exactly once.
    expect(takePendingCodingRun()).toBe("run-7");
    expect(takePendingCodingRun()).toBeNull();
  });
});
