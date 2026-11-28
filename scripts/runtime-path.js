"use strict";

/**
 * Node's `path` for the CommonJS scripts the Next app ALSO imports
 * (scripts/chat-media-owners.js, scripts/chat-reply-media.js): the same idea
 * as src/lib/runtime-path.ts. Turbopack spots `path.join` / `path.resolve`
 * by the module they came from and turns a call it can only partly resolve
 * into a glob over the project — `data/` included, where a coding run's venv
 * symlink makes the build fail (TASK-1102). Taken from here, they are plain
 * functions to the build, which traces nothing through them. References only,
 * never calls, in this file.
 */
const nodePath = require("path");

module.exports = {
  join: nodePath.join,
  resolve: nodePath.resolve,
  relative: nodePath.relative,
  dirname: nodePath.dirname,
  basename: nodePath.basename,
  isAbsolute: nodePath.isAbsolute,
  sep: nodePath.sep,
};
