import { describe, expect, it } from "vitest";
import {
  assessHarnessDowngrade,
  compareHarnessVersions,
  harnessDowngradeMessage,
  parseHermesPin,
  readHarnessDowngradeDetail,
  type OpenclawDowngradeInput,
} from "@/lib/harness-downgrade";

/**
 * The decision behind "this would install an older assistant": a box that ran
 * OpenClaw 2026.10.6 has agent databases on schema 25, and 2026.10.3 (agent
 * schema 24, the same state schema 20) refuses them outright — so switching it
 * to a branch that still pins 2026.10.3 left the gateway stopped. The numbers
 * below are the published packages' `openclaw.schemaVersions`.
 */

const COMMIT_OLD = "2237be355906fbe6065ce1815711eee52b2d646e";
const COMMIT_NEW = "4d04303818b61bf3aa09278af48356315515965b";

function openclaw(over: Partial<OpenclawDowngradeInput> = {}): OpenclawDowngradeInput {
  return {
    target: "2026.10.3",
    installed: "2026.10.6",
    onDisk: {
      state: { label: "/s/state/openclaw.sqlite", version: 20 },
      agent: { label: "/s/agents/main/agent/openclaw-agent.sqlite", version: 25 },
    },
    supported: { state: 20, agent: 24 },
    ...over,
  };
}

describe("compareHarnessVersions", () => {
  it("orders OpenClaw's calendar versions numerically, not as strings", () => {
    expect(compareHarnessVersions("2026.10.3", "2026.10.6")).toBe(-1);
    expect(compareHarnessVersions("2026.10.6", "2026.9.4")).toBe(1);
    expect(compareHarnessVersions("2026.10.6", "2026.10.6")).toBe(0);
  });

  it("puts a patch release after its base and before the next", () => {
    expect(compareHarnessVersions("2026.5.3-1", "2026.5.3")).toBe(1);
    expect(compareHarnessVersions("2026.5.3-1", "2026.5.4")).toBe(-1);
  });

  it("reads Hermes's v-prefixed releases", () => {
    expect(compareHarnessVersions("v0.21.1", "0.22.4")).toBe(-1);
  });

  it("answers null — no proof — for a dist-tag, a prerelease or nothing", () => {
    expect(compareHarnessVersions("beta", "2026.10.6")).toBeNull();
    expect(compareHarnessVersions("2026.5.24-beta.2", "2026.10.6")).toBeNull();
    expect(compareHarnessVersions(null, "2026.10.6")).toBeNull();
  });
});

describe("parseHermesPin", () => {
  it("reads the commit and the release name off beta's pin line", () => {
    const installer = '# Current pin: upstream tag v0.22.4 == "Hermes Agent v0.22.4".\n'
      + `HERMES_PIN_COMMIT="\${HERMES_PIN_COMMIT:-${COMMIT_NEW}}"\n`;
    expect(parseHermesPin(installer)).toEqual({ commit: COMMIT_NEW, version: "0.22.4" });
  });

  it("prefers the release name to a date tag (main's pin line)", () => {
    const installer = '# Current pin: upstream tag v2026.9.7 == "Hermes Agent v0.21.1" (pinned).\n'
      + `HERMES_PIN_COMMIT="\${HERMES_PIN_COMMIT:-${COMMIT_OLD}}"\n`;
    expect(parseHermesPin(installer)).toEqual({ commit: COMMIT_OLD, version: "0.21.1" });
  });

  it("names no version for a bare date tag, and nothing for an installer with no pin", () => {
    const installer = `# Current pin: upstream tag v2026.9.7\nHERMES_PIN_COMMIT="\${HERMES_PIN_COMMIT:-${COMMIT_OLD}}"\n`;
    expect(parseHermesPin(installer)).toEqual({ commit: COMMIT_OLD, version: null });
    expect(parseHermesPin("#!/bin/bash\n")).toBeNull();
  });
});

describe("assessHarnessDowngrade — a newer database is refused", () => {
  it("refuses 2026.10.3 over agent databases 2026.10.6 migrated to schema 25", () => {
    const [d, ...rest] = assessHarnessDowngrade({ openclaw: openclaw() });
    expect(rest).toEqual([]);
    expect(d).toEqual({
      harness: "openclaw",
      installed: "2026.10.6",
      target: "2026.10.3",
      schema: { database: "agent", label: "/s/agents/main/agent/openclaw-agent.sqlite", onDisk: 25, supported: 24 },
    });
  });

  it("refuses on the schema even when the installed core cannot be read", () => {
    const [d] = assessHarnessDowngrade({ openclaw: openclaw({ installed: null }) });
    expect(d?.schema).toMatchObject({ database: "agent", onDisk: 25, supported: 24 });
  });

  it("refuses a state database a newer core migrated", () => {
    const [d] = assessHarnessDowngrade({
      openclaw: openclaw({
        target: "2026.9.3",
        installed: "2026.9.4",
        onDisk: { state: { label: "/s/state/openclaw.sqlite", version: 17 }, agent: { label: "/a", version: 19 } },
        supported: { state: 16, agent: 19 },
      }),
    });
    expect(d?.schema).toMatchObject({ database: "state", onDisk: 17, supported: 16 });
  });

  it("refuses a target older than the core installed now, on the version alone", () => {
    const [d] = assessHarnessDowngrade({
      openclaw: openclaw({ onDisk: { state: null, agent: null }, supported: { state: null, agent: null } }),
    });
    expect(d).toEqual({ harness: "openclaw", installed: "2026.10.6", target: "2026.10.3" });
  });
});

describe("assessHarnessDowngrade — the same or an older database is allowed", () => {
  it("lets the same version through", () => {
    expect(assessHarnessDowngrade({
      openclaw: openclaw({ target: "2026.10.6", supported: { state: 20, agent: 25 } }),
    })).toEqual([]);
  });

  it("lets a newer core through over older databases, which it migrates forward", () => {
    expect(assessHarnessDowngrade({
      openclaw: openclaw({
        target: "2026.10.6",
        installed: "2026.10.3",
        onDisk: { state: { label: "/s", version: 20 }, agent: { label: "/a", version: 24 } },
        supported: { state: 20, agent: 25 },
      }),
    })).toEqual([]);
  });

  it("stands down on every unknown: no target, an unknown pin, a dist-tag", () => {
    expect(assessHarnessDowngrade({ openclaw: openclaw({ target: null }) })).toEqual([]);
    expect(assessHarnessDowngrade({
      openclaw: openclaw({ target: "2026.11.1", installed: "2026.10.6", supported: { state: null, agent: null } }),
    })).toEqual([]);
    expect(assessHarnessDowngrade({
      openclaw: openclaw({ target: "beta", onDisk: { state: null, agent: null } }),
    })).toEqual([]);
  });
});

describe("assessHarnessDowngrade — Hermes", () => {
  const target = { commit: COMMIT_OLD, version: "0.21.1" };

  it("refuses an older release than the one checked out", () => {
    expect(assessHarnessDowngrade({
      hermes: { target, installed: { commit: COMMIT_NEW, version: "0.22.4" }, targetIsAncestor: null },
    })).toEqual([{ harness: "hermes", installed: "0.22.4", target: "0.21.1", targetCommit: COMMIT_OLD }]);
  });

  it("refuses an older commit by ancestry when the versions cannot tell", () => {
    const [d] = assessHarnessDowngrade({
      hermes: { target: { commit: COMMIT_OLD, version: null }, installed: { commit: COMMIT_NEW, version: null }, targetIsAncestor: true },
    });
    expect(d).toMatchObject({ harness: "hermes", target: COMMIT_OLD.slice(0, 12) });
  });

  it("lets the pinned commit, a newer release and an unknown through", () => {
    expect(assessHarnessDowngrade({
      hermes: { target, installed: { commit: COMMIT_OLD, version: "0.21.1" }, targetIsAncestor: null },
    })).toEqual([]);
    expect(assessHarnessDowngrade({
      hermes: { target: { commit: COMMIT_NEW, version: "0.22.4" }, installed: { commit: COMMIT_OLD, version: "0.21.1" }, targetIsAncestor: false },
    })).toEqual([]);
    expect(assessHarnessDowngrade({
      hermes: { target: { commit: COMMIT_OLD, version: null }, installed: { commit: COMMIT_NEW, version: null }, targetIsAncestor: null },
    })).toEqual([]);
    expect(assessHarnessDowngrade({ hermes: { target, installed: null, targetIsAncestor: null } })).toEqual([]);
  });
});

describe("harnessDowngradeMessage", () => {
  const detail = { branch: "main", downgrades: assessHarnessDowngrade({ openclaw: openclaw() }) };

  it("says which database, which schema, and that nothing changed", () => {
    const text = harnessDowngradeMessage(detail, "before-update");
    expect(text).toContain("/s/agents/main/agent/openclaw-agent.sqlite is on agent schema 25");
    expect(text).toContain("the pinned OpenClaw 2026.10.3 supports schema 24");
    expect(text).toContain("the update was refused before it changed anything");
    expect(text).toContain("agent schema 25 or newer");
    expect(text).toContain('"Back up and update anyway"');
  });

  it("names the branch and its own override on the update-branch route", () => {
    const text = harnessDowngradeMessage(detail, "branch");
    expect(text).toMatch(/^Branch "main" would install an older assistant\. /);
    expect(text).toContain("the update branch was not changed");
    expect(text).toContain('"Back up and switch anyway"');
  });

  it("says the version for a refusal on the version alone", () => {
    const text = harnessDowngradeMessage({
      branch: null,
      downgrades: [{ harness: "openclaw", installed: "2026.10.6", target: "2026.10.3" }],
    }, "before-update");
    expect(text).toContain("This device runs OpenClaw 2026.10.6, and this update would install the older OpenClaw 2026.10.3");
  });
});

describe("readHarnessDowngradeDetail", () => {
  it("keeps a well-formed detail and drops anything else", () => {
    const detail = { branch: "main", downgrades: [{ harness: "openclaw", installed: "2026.10.6", target: "2026.10.3" }] };
    expect(readHarnessDowngradeDetail(detail)).toEqual(detail);
    expect(readHarnessDowngradeDetail({ downgrades: [{ harness: "other", target: "1" }] })).toBeNull();
    expect(readHarnessDowngradeDetail(null)).toBeNull();
  });
});
