/**
 * The canned harness smoke run (src/lib/coding-agent-harness-test.ts) against
 * a stubbed fetch.
 *
 * What is pinned: every refusal the module words itself goes through the
 * CALLER's translator — the module cannot reach the i18n context, and both
 * callers put its error straight into their error line, so an English literal
 * here would be the one line on the page that ignored the locale. The server's
 * own words still win when it gave any, a 409 from the folder step is the
 * normal "already there" and never a refusal, and success hands back the id of
 * the run so the caller can open its live view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codingAgentEn } from "@/lib/hermes-translations/en-coding-agent";
import { HARNESS_TEST_PROJECT, HARNESS_TEST_TASK, startHarnessTest } from "@/lib/coding-agent-harness-test";

/** A translator whose output is unmistakably the KEY, so a literal cannot pass. */
const t = (k: string) => `<${k}>`;

const fetchMock = vi.fn();

function answers(status: number, body: unknown = null): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === null) throw new Error("no body");
      return body;
    },
  } as Response);
}

function requestOf(call: number): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the translator keys it asks for", () => {
  it("exist in the English pack, so a caller's t() has something to say", () => {
    expect(codingAgentEn["codingAgent.harnessTestNoFolder"]).toBe("Choose a project folder first.");
    expect(codingAgentEn["codingAgent.wizardCreateFolderFailed"]).toBe("Could not create the folder.");
    expect(codingAgentEn["codingAgent.harnessTestFailed"]).toBe("Could not start the harness test");
  });
});

describe("without a project folder", () => {
  it("refuses through the translator and never touches the network", async () => {
    await expect(startHarnessTest(null, t)).resolves.toEqual({
      ok: false,
      error: "<codingAgent.harnessTestNoFolder>",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty string the same as none", async () => {
    await expect(startHarnessTest("", t)).resolves.toEqual({
      ok: false,
      error: "<codingAgent.harnessTestNoFolder>",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("creating the test folder", () => {
  it("asks for a bare-named folder inside the owner's default folder", async () => {
    answers(200);
    answers(200, { run: { id: "run-1" } });
    await startHarnessTest("/home/clawbox/projects", t);
    expect(requestOf(0)).toEqual({
      url: "/setup-api/coding-agent/browse",
      body: { dir: "/home/clawbox/projects", name: HARNESS_TEST_PROJECT },
    });
  });

  it("words a bodiless failure through the translator and stops there", async () => {
    answers(500);
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: false,
      error: "<codingAgent.wizardCreateFolderFailed>",
    });
    // The run must not be started in a folder that does not exist.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the server's own reason win when it gave one", async () => {
    answers(403, { error: "outside the project folder" });
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: false,
      error: "outside the project folder",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes 409 as 'already there' and goes on to start the run", async () => {
    answers(409, { error: "exists" });
    answers(200, { run: { id: "run-2" } });
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({ ok: true, runId: "run-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestOf(1).url).toBe("/setup-api/coding-agent/run");
  });
});

describe("starting the run", () => {
  it("posts the bare project name and the canned task", async () => {
    answers(200);
    answers(200, { run: { id: "run-3" } });
    await startHarnessTest("/home/clawbox/projects", t);
    expect(requestOf(1)).toEqual({
      url: "/setup-api/coding-agent/run",
      body: { directory: HARNESS_TEST_PROJECT, task: HARNESS_TEST_TASK },
    });
  });

  it("repeats the server's own words when it refused with a reason", async () => {
    answers(200);
    answers(500, { error: "boom" });
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({ ok: false, error: "boom" });
  });

  it("words a bodiless refusal through the translator", async () => {
    answers(200);
    answers(500);
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: false,
      error: "<codingAgent.harnessTestFailed>",
    });
  });

  it("answers ok with the id of the run it started", async () => {
    answers(200);
    answers(200, { run: { id: "run-k3x9q2ab" } });
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: true,
      runId: "run-k3x9q2ab",
    });
  });

  it("answers ok with a null id when the server sent none", async () => {
    answers(200);
    answers(200, {});
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({ ok: true, runId: null });
  });

  it("turns a thrown network error into its message, not a throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: false,
      error: "network down",
    });
  });

  it("words a throw that is not an Error through the translator", async () => {
    fetchMock.mockRejectedValueOnce("nope");
    await expect(startHarnessTest("/home/clawbox/projects", t)).resolves.toEqual({
      ok: false,
      error: "<codingAgent.harnessTestFailed>",
    });
  });
});
