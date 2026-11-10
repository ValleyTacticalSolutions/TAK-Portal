#!/usr/bin/env node
/**
 * CSS contracts for rem-based desktop density (replaces html { zoom: 0.8 }).
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const sidebarJs = fs.readFileSync(path.join(root, "public", "sidebar.js"), "utf8");
const mapCss = fs.readFileSync(path.join(root, "public", "map.css"), "utf8");

const stylesNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/html\s*\{[^}]*\bzoom\s*:/.test(stylesNoComments) &&
    !/\bzoom\s*:\s*0\.8\b/.test(stylesNoComments),
  "styles.css must not use html zoom: 0.8"
);
assert.ok(
  /@media\s*\(\s*min-width:\s*1024px\s*\)\s*\{[^}]*font-size:\s*80%/.test(styles),
  "desktop root density must use html { font-size: 80% }"
);
assert.ok(
  styles.includes("--font-base") && styles.includes("--radius-md") && styles.includes("--focus-ring"),
  "shared type/spacing tokens must exist"
);
assert.ok(
  styles.includes(".pageHeader") && styles.includes(".alertBanner") && styles.includes(".listCardTable"),
  "shared page chrome / CRUD classes must exist"
);
assert.ok(
  sidebarJs.includes('max-width: 990px') || sidebarJs.includes("max-width: 990px"),
  "sidebar.js mobile breakpoint must be 990px"
);
const mapNoComments = mapCss.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/\bzoom\s*:\s*0\.8\b/.test(mapNoComments),
  "map.css must not reintroduce html zoom: 0.8"
);

console.log("uiDensity.css.test.js: ok");
