/**
 * Money is handled in integer cents everywhere. Prices arrive either as numbers
 * (19.99) or as strings from the CSV import ("19.99", "$1,299.00").
 */
function toCents(amount) {
  const n = typeof amount === "string" ? Number(amount.replace(/[$,\s]/g, "")) : amount;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`not a money amount: ${amount}`);
  }
  return Math.floor(n * 100);
}

function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function lineTotal(price, qty) {
  if (!Number.isInteger(qty) || qty < 0) throw new RangeError("qty must be a non-negative integer");
  return toCents(price) * qty;
}

function invoiceTotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line.price, line.qty), 0);
}

module.exports = { toCents, formatCents, lineTotal, invoiceTotal };
