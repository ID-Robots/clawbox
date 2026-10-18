import { formatPrice } from "../data/products.js";

export function ProductList({ products }) {
  return (
    <ul className="product-list" aria-label="Products">
      {products.map((p) => (
        <li key={p.id} className="product">
          <h3>{p.name}</h3>
          <span className="price">{formatPrice(p.price)}</span>
        </li>
      ))}
    </ul>
  );
}
