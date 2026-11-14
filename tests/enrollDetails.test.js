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

test("mutual aid QR modal grows for details without an inner scrollbar", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "mutual-aid.ejs"), "utf8");
  const cssStart = html.indexOf("#qrOverlay .userQrModal");
  assert.ok(cssStart > 0, "expected #qrOverlay .userQrModal rules");
  const cssChunk = html.slice(cssStart, cssStart + 450);
  assert.match(cssChunk, /max-height:\s*calc\(100dvh\s*-\s*24px\)/);
  assert.match(cssChunk, /overflow:\s*hidden/);
  assert.doesNotMatch(cssChunk, /overflow:\s*auto/);
  assert.match(html, /classList\.add\("qr-details-open"\)/);
  assert.match(html, /classList\.remove\("qr-details-open"\)/);
});

test("mutual aid QR action buttons share width so Show Details fits", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "mutual-aid.ejs"), "utf8");
  const actionsCss = html.indexOf(".userQrPairActions .btn");
  assert.ok(actionsCss > 0);
  const chunk = html.slice(actionsCss, actionsCss + 280);
  assert.match(chunk, /flex:\s*1\s+1\s+0/);
  assert.doesNotMatch(html, /\.userQrPairActions\s+\.btn#qrSaveBtn\s*\{[^}]*flex:\s*2/);
  const colCss = html.indexOf(".userQrSingleCol");
  const colChunk = html.slice(colCss, colCss + 200);
  assert.match(colChunk, /max-width:\s*none/);
});
