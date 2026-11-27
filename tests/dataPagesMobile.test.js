/**
 * Proof: Data Sync and Data Package Manager are phone-friendly.
 * Bulk actions no longer force a 280px min-width, card cells can wrap
 * (inline nowrap is overridden), and the shared group filter row stacks on phones.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

for (const view of ["data-sync.ejs", "data-package.ejs"]) {
  const src = read("views", view);
  assert.doesNotMatch(src, /id="bulkActionsWrap"[^>]*min-width:\s*280px/, `${view}: no fixed 280px bulk actions width`);
  assert.match(src, /\.bulkActionsWrap\s*\{[^}]*min-width:\s*min\(280px,\s*100%\)/, `${view}: bulk wrap is capped to the container`);
  assert.match(src, /white-space:\s*normal\s*!important/, `${view}: card cells override inline nowrap on mobile`);
}

const css = read("public", "styles.css");
const mobile = css.match(/@media \(max-width: 640px\) \{\s*\.groupFilterRow \{[\s\S]*?\n\}\n/);
assert.ok(mobile, "styles.css must stack .groupFilterRow on phones");
assert.match(mobile[0], /flex-wrap:\s*wrap/);
assert.match(mobile[0], /\.groupFilterActions\s*\{[^}]*margin-left:\s*0/);

console.log("dataPagesMobile ok");
