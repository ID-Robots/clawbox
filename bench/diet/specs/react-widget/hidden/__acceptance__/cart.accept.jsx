import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Cart } from "../src/components/Cart.jsx";
import App from "../src/App.jsx";

const PRODUCTS = [
  { id: "mug", name: "Coffee mug", price: 12.5 },
  { id: "tee", name: "T-shirt", price: 19.99 },
  { id: "pin", name: "Enamel pin", price: 0.1 },
];

const add = (name) => fireEvent.click(screen.getByRole("button", { name: `Add ${name} to cart` }));
const qty = (name) => screen.getByLabelText(`Quantity for ${name}`);
const total = () => screen.getByTestId("cart-total").textContent;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Cart (acceptance)", () => {
  it("starts empty", () => {
    render(<Cart products={PRODUCTS} />);
    expect(screen.getByText(/your cart is empty/i)).toBeTruthy();
    expect(total()).toContain("$0.00");
  });

  it("adds lines, increments on repeat add, and derives the total", () => {
    render(<Cart products={PRODUCTS} />);
    add("Coffee mug");
    add("T-shirt");
    add("T-shirt");
    expect(screen.getByTestId("cart-line-mug")).toBeTruthy();
    expect(within(screen.getByTestId("cart-line-tee")).getByLabelText("Quantity for T-shirt").value).toBe("2");
    expect(screen.queryByText(/your cart is empty/i)).toBeNull();
    expect(total()).toContain("$52.48");
  });

  it("updates quantity from the input and rounds money correctly", () => {
    render(<Cart products={PRODUCTS} />);
    add("Enamel pin");
    fireEvent.change(qty("Enamel pin"), { target: { value: "3" } });
    expect(qty("Enamel pin").value).toBe("3");
    expect(total()).toContain("$0.30");
    add("T-shirt");
    fireEvent.change(qty("T-shirt"), { target: { value: "3" } });
    expect(total()).toContain("$60.27");
  });

  it("removes a line with its Remove button and with quantity 0", () => {
    render(<Cart products={PRODUCTS} />);
    add("Coffee mug");
    add("Enamel pin");
    fireEvent.click(screen.getByRole("button", { name: "Remove Coffee mug" }));
    expect(screen.queryByTestId("cart-line-mug")).toBeNull();
    expect(total()).toContain("$0.10");
    fireEvent.change(qty("Enamel pin"), { target: { value: "0" } });
    expect(screen.queryByTestId("cart-line-pin")).toBeNull();
    expect(screen.getByText(/your cart is empty/i)).toBeTruthy();
  });

  it("persists to localStorage under storageKey and restores on mount", () => {
    const first = render(<Cart products={PRODUCTS} storageKey="acc-cart" />);
    add("Coffee mug");
    add("Coffee mug");
    add("Enamel pin");
    expect(localStorage.getItem("acc-cart")).toBeTruthy();
    expect(localStorage.getItem("cart")).toBeNull();
    first.unmount();
    render(<Cart products={PRODUCTS} storageKey="acc-cart" />);
    expect(qty("Coffee mug").value).toBe("2");
    expect(total()).toContain("$25.10");
  });

  it("uses the default key 'cart' and survives corrupt stored data", () => {
    const first = render(<Cart products={PRODUCTS} />);
    add("T-shirt");
    expect(localStorage.getItem("cart")).toBeTruthy();
    first.unmount();
    localStorage.setItem("cart", "{not json");
    render(<Cart products={PRODUCTS} />);
    expect(screen.getByText(/your cart is empty/i)).toBeTruthy();
  });

  it("uses native, keyboard-reachable controls", () => {
    render(<Cart products={PRODUCTS} />);
    add("Coffee mug");
    for (const el of [
      screen.getByRole("button", { name: "Add Coffee mug to cart" }),
      screen.getByRole("button", { name: "Remove Coffee mug" }),
      qty("Coffee mug"),
    ]) {
      expect(["BUTTON", "INPUT"]).toContain(el.tagName);
      expect(el.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("is wired into App with the shop's products", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Add Coffee mug to cart" })).toBeTruthy();
    expect(screen.getByTestId("cart-total")).toBeTruthy();
  });
});
