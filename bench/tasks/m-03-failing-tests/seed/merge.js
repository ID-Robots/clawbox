"use strict";

/**
 * Merge overlapping or touching [start, end] intervals.
 *
 * Returns a new array of new intervals, sorted by start, with every overlap
 * collapsed. Touching intervals ([1,3] and [3,5]) merge. The input array and
 * its intervals are never mutated.
 */
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const result = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const current = intervals[i];
    const last = result[result.length - 1];
    if (current[0] < last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      result.push(current);
    }
  }
  return result;
}

module.exports = { mergeIntervals };
