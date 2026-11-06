import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProductList } from "./ProductList.jsx";

afterEach(cleanup);

describe("ProductList", () => {
  it("renders every product with its price", () => {
    render(<ProductList products={[{ id: "a", name: "Apple", price: 1.5 }, { id: "b", name: "Bread", price: 3 }]} />);
    const items = within(screen.getByRole("list", { name: "Products" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Apple");
    expect(items[0].textContent).toContain("$1.50");
    expect(items[1].textContent).toContain("$3.00");
  });
});
