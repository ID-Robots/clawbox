import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import { BuildDriftBanner, BuildIdentityRows, useBuildIdentity } from "@/components/BuildIdentityPanel";
import { computeDrift, type BuildIdentity } from "@/lib/build-identity";

// The real English strings, resolved the way the app resolves them — so a
// renamed or missing key fails here instead of shipping a raw "settings.foo"
// to the owner. Placeholder substitution mirrors src/lib/i18n.tsx.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

const BUILD_SHA = "1b21187aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "d285cfdbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function identity(over: { buildCommit?: string | null; headCommit?: string; pinned?: boolean; pinCommit?: string | null } = {}): BuildIdentity {
  const buildCommit = over.buildCommit === undefined ? BUILD_SHA : over.buildCommit;
  const headCommit = over.headCommit ?? HEAD_SHA;
  const build = buildCommit === null ? null : {
    commit: buildCommit,
    shortCommit: buildCommit.slice(0, 7),
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-21T20:00:00Z",
    builtAt: "2026-08-21T20:09:03Z",
    buildId: "f2aojibqYGT2Dg7DvAtYb",
    node: "v22.0.0",
    bun: "1.2.10",
    packageVersion: "3.9.0",
    hermesPin: null,
    openclawPin: null,
  };
  const checkout = {
    commit: headCommit,
    shortCommit: headCommit.slice(0, 7),
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-22T03:00:00Z",
  };
  const pin = {
    branch: "beta",
    source: "pin-file" as const,
    commit: over.pinCommit === undefined ? headCommit : over.pinCommit,
    pinned: over.pinned ?? true,
  };
  return {
    build,
    deployedBuildId: build?.buildId ?? "legacybuild",
    checkout,
    pin,
    drift: computeDrift({
      build,
      deployedBuildId: build?.buildId ?? "legacybuild",
      buildTimestampMs: Date.parse("2026-08-21T20:09:03Z"),
      checkout,
      pin,
      stamperInCheckout: true,
    }),
  };
}

describe("BuildDriftBanner", () => {
  it("says in plain language which build is running and which code is on disk", () => {
    render(<BuildDriftBanner identity={identity()} />);

    expect(screen.getByText(translations.en["settings.driftTitle"])).toBeInTheDocument();
    const line = screen.getByText(/running a build from/i);
    expect(line.textContent).toContain("1b21187");
    expect(line.textContent).toContain("d285cfd");
    expect(line.textContent).toMatch(/run Update to realign/i);
  });

  it("stays out of the way on a box that agrees with itself", () => {
    const { container } = render(<BuildDriftBanner identity={identity({ buildCommit: HEAD_SHA })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before the endpoint answers", () => {
    const { container } = render(<BuildDriftBanner identity={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not raise the banner for a merely unpinned box", () => {
    const { container } = render(
      <BuildDriftBanner identity={identity({ buildCommit: HEAD_SHA, pinned: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains an unstamped build rather than showing a raw code", () => {
    render(<BuildDriftBanner identity={identity({ buildCommit: null })} />);
    expect(screen.getByText(translations.en["settings.driftBuildUnstamped"])).toBeInTheDocument();
    expect(screen.queryByText(/build-unstamped/)).not.toBeInTheDocument();
  });

  it("names the tested commit the checkout is behind", () => {
    render(<BuildDriftBanner identity={identity({ buildCommit: HEAD_SHA, pinCommit: BUILD_SHA })} />);
    const line = screen.getByText(/is not the tested commit/i);
    expect(line.textContent).toContain("beta");
    expect(line.textContent).toContain("1b21187");
  });
});

describe("BuildIdentityRows", () => {
  it("shows the build commit, branch and build time", () => {
    render(<BuildIdentityRows identity={identity({ buildCommit: HEAD_SHA })} />);

    expect(screen.getByText(translations.en["settings.buildCommit"])).toBeInTheDocument();
    expect(screen.getByText("d285cfd")).toBeInTheDocument();
    expect(screen.getByText(translations.en["settings.buildBranch"])).toBeInTheDocument();
    expect(screen.getByText(translations.en["settings.builtAt"])).toBeInTheDocument();
  });

  // On a healthy box the two are the same commit; showing both would be noise.
  it("adds the code-on-disk row only when it disagrees with the build", () => {
    const { rerender } = render(<BuildIdentityRows identity={identity({ buildCommit: HEAD_SHA })} />);
    expect(screen.queryByText(translations.en["settings.checkoutCommit"])).not.toBeInTheDocument();

    rerender(<BuildIdentityRows identity={identity()} />);
    expect(screen.getByText(translations.en["settings.checkoutCommit"])).toBeInTheDocument();
    expect(screen.getByText("d285cfd")).toBeInTheDocument();
    expect(screen.getByText("1b21187")).toBeInTheDocument();
  });
});

describe("useBuildIdentity", () => {
  function Probe({ enabled }: { enabled: boolean }) {
    const id = useBuildIdentity(enabled);
    return <span data-testid="probe">{id ? id.checkout.shortCommit : "none"}</span>;
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => identity() })));
  });

  it("fetches once when the section that shows it is open", async () => {
    render(<Probe enabled />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("d285cfd"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/setup-api/system/build-identity");
  });

  // git subprocesses on a Jetson: not something to run for a screen nobody
  // has open.
  it("does not touch the endpoint from a section that never shows it", () => {
    render(<Probe enabled={false} />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves the UI blank when the endpoint errors instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "nope" }) })));
    render(<Probe enabled />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("none"));
  });
});

describe("malformed responses", () => {
  function Probe() {
    const id = useBuildIdentity(true);
    return <BuildDriftBanner identity={id} />;
  }

  // A proxy error page, a half-deployed server, or an older build answering
  // this path can all return 200 with a body that is not a BuildIdentity.
  // Rendering that must not take the Settings window down over a diagnostic.
  it.each([
    ["an empty object", {}],
    ["a payload with no drift", { checkout: { commit: "abc" }, pin: {} }],
    ["an error envelope", { error: "boom" }],
    ["a string", "not json at all"],
    ["null", null],
    // Passes the top-level shape check but would make React throw on an
    // object child.
    ["an object where a commit string belongs", {
      drift: { codes: ["build-from-other-commit"], detected: true, reasons: ["x"] },
      checkout: { shortCommit: {}, branch: "beta" },
      pin: { branch: "beta", commit: null },
      build: null,
    }],
    ["a non-string branch on the build", {
      drift: { codes: [], detected: true, reasons: [] },
      checkout: { shortCommit: "abc1234", branch: "beta" },
      pin: { branch: "beta", commit: null },
      build: { shortCommit: "abc1234", branch: ["beta"], builtAt: null },
    }],
    ["codes that are not strings", {
      drift: { codes: [{}], detected: true, reasons: ["x"] },
      checkout: { shortCommit: "abc1234", branch: "beta" },
      pin: { branch: "beta", commit: null },
      build: null,
    }],
  ])("ignores %s instead of crashing", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
    const { container } = render(<Probe />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
