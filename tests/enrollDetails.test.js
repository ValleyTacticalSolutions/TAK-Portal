const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parseEnrollUrl } = require("../public/enrollDetails.js");

test("parseEnrollUrl returns host, username and password from an enroll URL", () => {
  const d = parseEnrollUrl(
    "tak://com.atakmap.app/enroll?host=tak.example.org&username=ma%20user%2B1&token=p%40ss%26word"
  );
  assert.deepStrictEqual(d, { host: "tak.example.org", username: "ma user+1", password: "p@ss&word" });
});

test("parseEnrollUrl returns null for empty or non-enroll input", () => {
  assert.strictEqual(parseEnrollUrl(""), null);
  assert.strictEqual(parseEnrollUrl("nothing"), null);
});

test("mutual aid QR modal has a Show Details button after Copy URL", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "mutual-aid.ejs"), "utf8");
  const copy = html.indexOf('id="qrCopyBtn"');
  const details = html.indexOf('id="qrDetailsBtn"');
  assert.ok(copy > 0 && details > copy, "qrDetailsBtn must follow qrCopyBtn");
  assert.match(html, /id="qrDetailsPanel"/);
  assert.match(html, /\/enrollDetails\.js/);
});

test("QR modal action buttons are never narrower than their text", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "mutual-aid.ejs"), "utf8");
  const rule = html.match(/\.userQrPairActions \.btn \{[^}]*\}/);
  assert.ok(rule, "base button rule exists");
  assert.match(rule[0], /min-width:\s*max-content/);
  assert.doesNotMatch(html, /\.userQrPairActions \.btn#qr\w+Btn \{\s*flex:\s*\d+ 1 0;/);
});

test("QR modal image shrinks with viewport height so Show Details does not force a scroll", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "mutual-aid.ejs"), "utf8");
  const img = html.match(/\.userQrPairImg \{[^}]*\}/);
  assert.ok(img, "image rule exists");
  assert.match(img[0], /max-height:\s*\d+vh/);
  const modal = html.match(/\.userQrModal \{[^}]*\}/);
  assert.match(modal[0], /max-height:\s*calc\(100d?vh - 36px\)/);
});
