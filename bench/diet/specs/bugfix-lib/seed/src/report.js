/**
 * Dashboard widgets. `orders` is the same array the admin order table renders,
 * shaped { id, customer, totalCents, placedAt } with placedAt an ISO-8601 string.
 */
function latestOrders(orders, n = 5) {
  return orders.sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt)).slice(0, n);
}

function topCustomers(orders, n = 3) {
  const totals = new Map();
  for (const o of orders) totals.set(o.customer, (totals.get(o.customer) || 0) + o.totalCents);
  return [...totals]
    .map(([customer, totalCents]) => ({ customer, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents || a.customer.localeCompare(b.customer))
    .slice(0, n);
}

module.exports = { latestOrders, topCustomers };
