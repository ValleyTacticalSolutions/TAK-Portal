/**
 * Proof: authenticated app shell includes the Valley Tactical Solutions site footer.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sidebar = fs.readFileSync(
  path.join(__dirname, "..", "views", "partials", "sidebar.ejs"),
  "utf8"
);
const footer = fs.readFileSync(
  path.join(__dirname, "..", "views", "partials", "site-footer.ejs"),
  "utf8"
);
const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

assert.match(
  sidebar,
  /include\(["']\.\/site-footer["']\)/,
  "sidebar must include ./site-footer (relative to partials/, not partials/site-footer)"
);
assert.match(footer, /© 2026 Valley Tactical Solutions/);
assert.match(footer, /GNU AGPL v3/);
assert.doesNotMatch(footer, /<a\b/, "footer must not link the AGPL text");
assert.doesNotMatch(footer, /gnu\.org/, "footer must not include a GNU license URL");
assert.match(footer, /map-page/, "footer must stay off the live map page");
assert.match(styles, /\.site-footer\s*\{/, "styles.css must define .site-footer");

console.log("siteFooter.test.js: ok");
