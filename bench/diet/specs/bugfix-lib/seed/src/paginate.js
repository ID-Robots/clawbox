/**
 * Split `items` into pages for list views. `page` is 1-based and is clamped
 * into the valid range, so callers can pass whatever came in the query string.
 * Returns { items, page, perPage, total, totalPages }.
 */
function paginate(items, page = 1, perPage = 10) {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError("perPage must be a positive integer");
  }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const wanted = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 1;
  const current = Math.min(Math.max(1, wanted), totalPages);
  const start = current * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: current,
    perPage,
    total,
    totalPages,
  };
}

module.exports = { paginate };
