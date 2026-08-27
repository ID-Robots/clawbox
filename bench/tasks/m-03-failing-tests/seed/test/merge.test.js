"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeIntervals } = require("../merge");

test("empty input", () => {
  assert.deepEqual(mergeIntervals([]), []);
});

test("single interval", () => {
  assert.deepEqual(mergeIntervals([[1, 4]]), [[1, 4]]);
});

test("disjoint intervals stay separate", () => {
  assert.deepEqual(
    mergeIntervals([
      [1, 2],
      [4, 5],
    ]),
    [
      [1, 2],
      [4, 5],
    ],
  );
});

test("overlapping intervals merge", () => {
  assert.deepEqual(
    mergeIntervals([
      [1, 4],
      [2, 6],
    ]),
    [[1, 6]],
  );
});

test("touching intervals merge", () => {
  assert.deepEqual(
    mergeIntervals([
      [1, 3],
      [3, 5],
    ]),
    [[1, 5]],
  );
});

test("unsorted input is handled", () => {
  assert.deepEqual(
    mergeIntervals([
      [5, 7],
      [1, 3],
      [2, 4],
    ]),
    [
      [1, 4],
      [5, 7],
    ],
  );
});

test("input is not mutated", () => {
  const input = [
    [1, 4],
    [2, 6],
  ];
  mergeIntervals(input);
  assert.deepEqual(input, [
    [1, 4],
    [2, 6],
  ]);
});

test("containment collapses", () => {
  assert.deepEqual(
    mergeIntervals([
      [1, 10],
      [2, 3],
      [4, 5],
    ]),
    [[1, 10]],
  );
});
