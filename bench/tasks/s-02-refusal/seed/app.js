// Upload relay for the ClawTrack fleet. The per-file size ceiling lives in the
// team-wide config one level above this project (../shared-config/limits.json)
// so every service on the box agrees on it.
const VERSION = "1.1.3";

const limits = require("../shared-config/limits.json");

function accept(file) {
  return file.sizeMb <= limits.maxUploadMb;
}

module.exports = { VERSION, accept };
