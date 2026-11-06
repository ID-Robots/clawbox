/**
 * "CI failed" on a run's page (CodingRunCiCard): what failed — the checks,
 * the failing tests, the files, the end of the log — and the Fix CI
 * continuation it offers, bounded the way the server is. The real English
 * catalogue throughout, so a missing key fails here rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunCiCard, { type RunCiView } from "@/components/CodingRunCiCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const CI: RunCiView = {
  prNumber: 7,
  checks: ["test (20.x)", "lint"],
  tests: ["src/tests/unit/cart.test.ts > cart > adds the tax"],
  files: ["src/lib/cart.ts"],
  excerpt: "AssertionError: expected 10 to be 11",
  unread: ["lint"],
  attempt: 0,
  fixRunId: null,
};

let posts: { url: string; body: unknown }[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    posts.push({ url: input.toString(), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ started: true, run: { id: "run-fixfix01" } }), { status: 202, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const chip = (id: string) => <span data-testid={`chip-${id}`}>{id}</span>;

describe("CodingRunCiCard", () => {
  it("says what failed — checks, tests, files, the unread, the log — in the owner's words", () => {
    render(<CodingRunCiCard runId="run-k3x9q2ab" ci={CI} settled onStarted={() => {}} runChip={chip} />);
    expect(screen.getByTestId("coding-agent-run-ci")).toHaveTextContent("CI failed on pull request #7");
    expect(screen.getByTestId("coding-agent-ci-checks")).toHaveTextContent("Failing checks: test (20.x), lint");
    expect(screen.getByTestId("coding-agent-ci-tests")).toHaveTextContent("Failing tests (1):src/tests/unit/cart.test.ts > cart > adds the tax");
    // Labelled, so the list is never read as one more failing test.
    expect(screen.getByTestId("coding-agent-ci-files")).toHaveTextContent("Files the failure names: src/lib/cart.ts");
    expect(screen.getByText("No log could be read for: lint")).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-ci-log")).toHaveTextContent("AssertionError: expected 10 to be 11");
  });

  it("starts a Fix CI continuation of this run and opens it", async () => {
    const started: string[] = [];
    render(<CodingRunCiCard runId="run-k3x9q2ab" ci={CI} settled onStarted={(id) => started.push(id)} runChip={chip} />);
    fireEvent.click(screen.getByTestId("coding-agent-ci-fix"));
    await waitFor(() => expect(started).toEqual(["run-fixfix01"]));
    expect(screen.getByTestId("coding-agent-ci-fix")).toHaveTextContent("Fix CI (1 of 2)");
    expect(posts).toEqual([{ url: "/setup-api/coding-agent/run", body: { task: "Fix the failing CI checks on pull request #7.", resumeRunId: "run-k3x9q2ab", fixCi: true } }]);
  });

  it("offers nothing while the run works, links the Fix CI already started, and says when the attempts are used up", () => {
    const { rerender } = render(<CodingRunCiCard runId="run-k3x9q2ab" ci={CI} settled={false} onStarted={() => {}} runChip={chip} />);
    expect(screen.queryByTestId("coding-agent-ci-fix")).toBeNull();
    rerender(<CodingRunCiCard runId="run-k3x9q2ab" ci={{ ...CI, fixRunId: "run-fixfix01" }} settled onStarted={() => {}} runChip={chip} />);
    expect(screen.queryByTestId("coding-agent-ci-fix")).toBeNull();
    expect(screen.getByTestId("chip-run-fixfix01")).toBeInTheDocument();
    rerender(<CodingRunCiCard runId="run-k3x9q2ab" ci={{ ...CI, attempt: 2 }} settled onStarted={() => {}} runChip={chip} />);
    expect(screen.queryByTestId("coding-agent-ci-fix")).toBeNull();
    expect(screen.getByTestId("coding-agent-ci-exhausted")).toHaveTextContent("The 2 Fix CI attempts are used up");
  });
});
