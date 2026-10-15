import { describe, expect, it } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import PrimeRadiantIcon from "@/components/PrimeRadiantIcon";
import { apps } from "@/lib/desktop-apps";

describe("Prime Radiant's icon", () => {
  it("is vector art, hidden from assistive tech, sized by its class", () => {
    const { container } = render(<PrimeRadiantIcon className="w-12 h-12" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 48");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toBe("w-12 h-12");
    expect(svg.querySelectorAll("path").length).toBe(6);
    expect(container.querySelector("img")).toBeNull();
  });

  it("gives every copy its own gradient, so two on screen do not share one id", () => {
    const { container } = render(<><PrimeRadiantIcon /><PrimeRadiantIcon /></>);
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const outer = [...container.querySelectorAll("svg")].map((s) => s.querySelector("path:last-of-type")!.getAttribute("stroke"));
    expect(outer).toEqual(ids.map((id) => `url(#${id})`));
  });

  it("sits on a dark blue tile, not the old brown one", () => {
    const app = apps.find((a) => a.id === "prime-radiant");
    expect(app?.color).toBe("#0f2a52");
  });
});
