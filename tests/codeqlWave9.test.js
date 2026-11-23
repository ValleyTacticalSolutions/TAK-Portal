/**
 * Proof (CodeQL wave 9): error text is never sent as HTML, the callsign format attribute is
 * escaped, and the integration cert command only accepts a validated username.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// 1. No `.send(err.message)` on the MOU routes (Express would label a string text/html).
const mou = read("routes/mou.routes.js");
assert.ok(!/\.status\(404\)\.send\(err\?\.message/.test(mou), "mou route sends err.message directly");
assert.ok(/function sendPlainError[\s\S]*?res\.type\("text\/plain"\)/.test(mou), "sendPlainError must set text/plain");
assert.strictEqual((mou.match(/sendPlainError\(res, 404,/g) || []).length, 5);

const ma = read("routes/mutualAid.routes.js");
assert.ok(
  /res\.type\("text\/plain"\);\s*res\.status\(statusForError\(err\)\)\.send\(/.test(ma),
  "mutual aid QR error must be text/plain"
);

// 2. Callsign format attribute is HTML-escaped (<%= not <%-).
const settings = read("views/settings.ejs");
assert.ok(
  /id="callsignFormatInput"[\s\S]{0,200}value="<%= \(settings\.CALLSIGN_FORMAT_EXPRESSION/.test(settings),
  "callsign format value must use <%="
);
assert.ok(!/value="<%- \(settings\.CALLSIGN_FORMAT_EXPRESSION/.test(settings));

// 3. Integration cert creation rejects usernames that are not plain slugs (no remote call made).
const remote = require("../services/takSsh.service");
(async () => {
  for (const bad of ["a'; touch /tmp/x; '", "a b", "A$(id)", "-rf"]) {
    const r = await remote.createTakClientCertForIntegration(bad);
    assert.strictEqual(r.ok, false, "accepted: " + bad);
    assert.ok(/Invalid integration username/.test(r.message), r.message);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
