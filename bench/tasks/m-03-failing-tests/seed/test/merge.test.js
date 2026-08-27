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
  // Two shapes on purpose: the unsorted one catches an implementation that
  // sorts the caller's array in place, the sorted overlapping one catches a
  // result that aliases the caller's intervals and widens them in place.
  const unsorted = [
    [5, 7],
    [1, 4],
    [2, 6],
  ];
  mergeIntervals(unsorted);
  assert.deepEqual(unsorted, [
    [5, 7],
    [1, 4],
    [2, 6],
  ]);

  const sorted = [
    [1, 4],
    [2, 6],
  ];
  mergeIntervals(sorted);
  assert.deepEqual(sorted, [
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
