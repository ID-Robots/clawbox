"use strict";

// Central registry of unit conversions. Every unit module registers its
// conversions here; the CLI and the tests only ever talk to the registry.
const CONVERSIONS = new Map();

/**
 * Register a conversion.
 * @param {string} from unit name, lower case (e.g. "meters")
 * @param {string} to unit name, lower case (e.g. "feet")
 * @param {(value: number) => number} fn
 */
function register(from, to, fn) {
  if (CONVERSIONS.has(`${from}:${to}`)) {
    throw new Error(`duplicate conversion ${from} -> ${to}`);
  }
  CONVERSIONS.set(`${from}:${to}`, fn);
}

function convert(from, to, value) {
  const fn = CONVERSIONS.get(`${from}:${to}`);
  if (!fn) throw new Error(`no conversion ${from} -> ${to}`);
  return fn(value);
}

function list() {
  return [...CONVERSIONS.keys()].map((key) => {
    const [from, to] = key.split(":");
    return { from, to };
  });
}

module.exports = { register, convert, list };
