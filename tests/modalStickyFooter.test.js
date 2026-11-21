/**
 * Proof: sticky modal footers use shared .modalStickyFooter chrome (solid border),
 * never a soft upward blur that washes a gradient over the last field.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const softUpwardBlur = /box-shadow:\s*0\s+-10px\s+16px\s+var\(--raised\)/;

const stickyRule = styles.match(/\.modalStickyFooter\s*\{([\s\S]*?)\}/);
assert.ok(stickyRule, "styles.css must define .modalStickyFooter");
assert.match(stickyRule[1], /position:\s*sticky/);
assert.match(stickyRule[1], /bottom:\s*0/);
assert.match(stickyRule[1], /background:\s*var\(--raised\)/);
assert.match(stickyRule[1], /border-top:\s*1px\s+solid\s+var\(--line\)/);
assert.match(stickyRule[1], /box-shadow:\s*none/);
assert.doesNotMatch(stickyRule[1], softUpwardBlur);

const offenders = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ejs|css)$/.test(name)) continue;
    if (softUpwardBlur.test(fs.readFileSync(full, "utf8"))) {
      offenders.push(path.relative(root, full));
    }
  }
}
walk(path.join(root, "views"));
walk(path.join(root, "public"));
assert.deepStrictEqual(
  offenders,
  [],
  "soft upward footer blur must stay gone; found in: " + offenders.join(", ")
);

const footers = [
  ["views/groups.ejs", "editGroupFooter"],
  ["views/groups.ejs", "membersMassFooter"],
  ["views/templates.ejs", "editTemplateFooter"],
  ["views/agencies.ejs", "editAgencyFooter"],
  ["views/mutual-aid.ejs", "membersMassFooter"],
  ["views/data-sync.ejs", "editDataSyncFooter"],
];
for (const [rel, cls] of footers) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(
    src,
    new RegExp(`class=["'][^"']*\\bmodalStickyFooter\\b[^"']*\\b${cls}\\b`),
    `${rel} ${cls} must include shared modalStickyFooter class`
  );
}

console.log("modalStickyFooter.test.js: ok");
