# orderkit

Small, dependency-free helpers shared by the admin UI and the dashboard.

- `paginate(items, page, perPage)` — 1-based pages for list views
- `toCents(amount)`, `formatCents(cents)`, `lineTotal(price, qty)`, `invoiceTotal(lines)` — money in integer cents
- `latestOrders(orders, n)`, `topCustomers(orders, n)` — dashboard widgets

Run the tests with `npm test`.
