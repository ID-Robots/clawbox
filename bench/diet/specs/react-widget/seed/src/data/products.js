export const PRODUCTS = [
  { id: "mug", name: "Coffee mug", price: 12.5 },
  { id: "tee", name: "T-shirt", price: 19.99 },
  { id: "pin", name: "Enamel pin", price: 0.1 },
];

// Two decimals, in cents, so `0.1 + 0.2` never leaks floating-point noise.
export function formatPrice(amount) {
  return `$${(Math.round(amount * 100) / 100).toFixed(2)}`;
}
