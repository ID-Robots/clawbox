import { ProductList } from "./components/ProductList.jsx";
import { PRODUCTS } from "./data/products.js";

export default function App() {
  return (
    <main>
      <h1>Shop front</h1>
      <ProductList products={PRODUCTS} />
    </main>
  );
}
