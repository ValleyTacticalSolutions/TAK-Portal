"use strict";

// archiver 8 is ESM-only with named exports. Node >=22.12 can require() it
// synchronously, so this one wrapper keeps the old `archiver("zip", opts)`
// call shape for the rest of the CommonJS app.
const { ZipArchive } = require("archiver");

function createZipArchive(options) {
  return new ZipArchive(options);
}

module.exports = { createZipArchive };
