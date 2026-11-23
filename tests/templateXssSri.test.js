/**
 * Proof: HTML escape helpers in templates escape single quotes (attribute breakout),
 * and CDN scripts carry SRI integrity hashes.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const views = path.join(__dirname, "..", "views");
const read = (f) => fs.readFileSync(path.join(views, f), "utf8");

function extractFn(src, re) {
  const m = src.match(re);
  assert.ok(m, "helper not found: " + re);
  return new Function("return (" + m[0] + ")")();
}

const payload = `'><script>alert(1)</script>"&`;

const esc = extractFn(read("data-package.ejs"), /function esc\(s\) \{[\s\S]*?\n  \}/);
const escHtml = extractFn(read("setup-my-device.ejs"), /function escapeHtml\(s\) \{[\s\S]*?\n  \}/);
for (const fn of [esc, escHtml]) {
  const out = fn(payload);
  assert.ok(!/['"<>]/.test(out), "unescaped char in: " + out);
  assert.strictEqual(out, "&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;");
}

for (const f of ["mutual-aid.ejs", "mou_sign.ejs"]) {
  const tags = read(f).match(/<script[^>]+src="https?:\/\/[^"]+"[^>]*>/g) || [];
  assert.ok(tags.length > 0, f + " should load CDN scripts");
  for (const t of tags) {
    assert.match(t, /integrity="sha384-[A-Za-z0-9+/=]+"/, "missing SRI: " + t);
    assert.match(t, /crossorigin="anonymous"/, "missing crossorigin: " + t);
  }
}
console.log("templateXssSri ok");
