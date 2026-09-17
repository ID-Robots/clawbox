/**
 * "Inputs for this run" (src/components/CodingRunInputs.tsx), and the note the
 * refusal panel carries beside it.
 *
 * Both exist for one question the device never answered: a run was refused a
 * file the assistant had made for it, and nothing on screen said where such a
 * file is supposed to go. So the properties under test are the two the owner
 * acts on — the folder is named even when a run was given nothing, and the
 * refusal panel says that the assistant's own media folder is not one of the
 * places a rule could open.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunInputs from "@/components/CodingRunInputs";
import CodingRunDenials from "@/components/CodingRunDenials";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const DIR = "/home/clawbox/clawbox/data/coding-agent-inputs/run-k3x9q2ab";
const SHARED = "/home/clawbox/clawbox/data/coding-agent-inputs/shared";

describe("CodingRunInputs", () => {
  it("lists what the run was given and names both folders", () => {
    render(<CodingRunInputs inputs={{ dir: DIR, shared: SHARED, files: [{ name: "chart.png", bytes: 2048 }] }} />);
    const card = screen.getByTestId("coding-agent-inputs");
    expect(card).toHaveTextContent("chart.png");
    expect(card).toHaveTextContent(DIR);
    expect(card).toHaveTextContent(SHARED);
    expect(screen.queryByTestId("coding-agent-inputs-empty")).toBeNull();
  });

  it("still names the folder for a run that was given nothing — that is the answer to 'where do I put it'", () => {
    render(<CodingRunInputs inputs={{ dir: DIR, shared: SHARED, files: [] }} />);
    expect(screen.getByTestId("coding-agent-inputs-empty")).toHaveTextContent(t("codingAgent.inputsEmpty"));
    expect(screen.getByTestId("coding-agent-inputs")).toHaveTextContent(DIR);
  });

  it("words a refusal from the catalogue, and says nothing at all for a code it does not know", () => {
    render(
      <CodingRunInputs
        inputs={{
          dir: DIR,
          shared: SHARED,
          files: [],
          refused: [
            { name: "key.png", code: "outside_roots" },
            { name: "later.png", code: "something_new" },
          ],
        }}
      />,
    );
    const refused = screen.getByTestId("coding-agent-inputs-refused");
    expect(refused).toHaveTextContent(t("codingAgent.inputsRefusedLocation"));
    expect(refused).toHaveTextContent("later.png");
    expect(refused).not.toHaveTextContent("something_new");
  });

  it("draws nothing for a record written before the hand-over existed", () => {
    render(<CodingRunInputs inputs={null} />);
    expect(screen.queryByTestId("coding-agent-inputs")).toBeNull();
  });
});

describe("CodingRunDenials", () => {
  const denials = [{ text: "Read: /home/clawbox/.openclaw/media/chart.png", rule: null, refusal: "protected" }];

  it("names the folders a run may read, so the owner knows where the file should have gone", () => {
    render(
      <CodingRunDenials
        runId="run-k3x9q2ab"
        inputs={{ dir: DIR, shared: SHARED }}
        denials={denials}
        resumable={false}
      />,
    );
    const note = screen.getByTestId("coding-agent-denied-inputs");
    expect(note).toHaveTextContent(DIR);
    expect(note).toHaveTextContent(SHARED);
  });

  it("leaves the note off a record that cannot say where its inputs are", () => {
    render(<CodingRunDenials runId="run-k3x9q2ab" denials={denials} resumable={false} />);
    expect(screen.queryByTestId("coding-agent-denied-inputs")).toBeNull();
    // The panel itself is unchanged.
    expect(screen.getByTestId("coding-agent-denied")).toBeTruthy();
  });
});
