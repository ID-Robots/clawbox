#!/usr/bin/env node
"use strict";

// unitctl — tiny unit conversion CLI.
//
//   node cli.js list
//   node cli.js convert <value> <from> <to>
//
// Unit modules are loaded here, one require per module; each module registers
// itself with the registry.
require("./lib/length");
require("./lib/mass");

const { convert, list } = require("./lib/registry");

const [, , cmd, ...rest] = process.argv;

if (cmd === "list") {
  for (const { from, to } of list()) {
    console.log(`${from} -> ${to}`);
  }
} else if (cmd === "convert" && rest.length === 3) {
  const [value, from, to] = rest;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.error(`not a number: ${value}`);
    process.exit(1);
  }
  console.log(String(convert(from, to, n)));
} else {
  console.error("usage: unitctl list | unitctl convert <value> <from> <to>");
  process.exit(1);
}
