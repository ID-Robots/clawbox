import { describe, expect, it, vi } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import PortalSubscribePage from "@/app/portal/subscribe/page";

vi.mock("next/image", () => ({
  default: () => null,
}));

describe("PortalSubscribePage", () => {
  it("renders the Max-focused subscription messaging and portal CTA", () => {
    const { getAllByText, getByRole, getByText } = render(<PortalSubscribePage />);

    expect(getByText("Upgrade to ClawBox AI Max with the same email you used to buy your ClawBox.")).toBeInTheDocument();
    expect(getByText("Use the same email address as your ClawBox purchase to unlock the bonus.")).toBeInTheDocument();
    expect(getAllByText("Maximum usage").length).toBeGreaterThan(0);
    expect(getByRole("link", { name: /Sign in to subscribe/i })).toHaveAttribute("href", "https://openclawhardware.dev/portal");
  });
});
