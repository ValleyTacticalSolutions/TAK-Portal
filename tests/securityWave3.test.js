/**
 * Proof: CodeQL wave 3 (path injection, ReDoS, regex injection, HTML sanitizing) fixes.
 * Each assertion fails against the old code.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
function timed(label, fn, maxMs = 500) {
  const t = Date.now();
  const out = fn();
  const ms = Date.now() - t;
  assert.ok(ms < maxMs, `${label} took ${ms}ms (crafted input must stay linear)`);
  return out;
}

// ---- path injection -------------------------------------------------------
const { resolveInside } = require("../services/safePath");
const base = path.join(os.tmpdir(), "wave3-base");
assert.strictEqual(resolveInside(base, "a.txt"), path.join(base, "a.txt"));
assert.throws(() => resolveInside(base, "../etc/passwd"), /Illegal path/);
assert.throws(() => resolveInside(base, "/etc/passwd"), /Illegal path/);
assert.throws(() => resolveInside(base, path.join(base + "-evil", "x")), /Illegal path/);
assert.throws(() => resolveInside(base, "a\0b"), /Illegal path/);

const atak = require("../services/atakApk.service");
assert.throws(() => atak.saveUploadedApk("../../../etc/hostname", "x.apk"), /Illegal path/);

const backupFiles = require("../services/backup/files");
assert.throws(
  () => backupFiles.peekIsEncrypted(path.join(os.tmpdir(), "..", "etc", "hostname")),
  /Illegal path/
);
assert.throws(
  () => backupFiles.maybeDecryptToZip("../../etc/hostname", "", os.tmpdir()),
  /Illegal path/
);

(async () => {
  const plugins = require("../services/plugins.service");
  const r = await plugins.addPluginFromFile("../../../etc/hostname", {});
  assert.strictEqual(r.success, false);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---- ReDoS ----------------------------------------------------------------
const { isValidEmail, trimChar, escapeRegExp } = require("../services/safeRegex");
assert.strictEqual(isValidEmail("a@b.co"), true);
assert.strictEqual(isValidEmail("a@b"), false);
assert.strictEqual(isValidEmail("a b@c.com"), false);
assert.strictEqual(isValidEmail("@c.com"), false);
timed("email", () => isValidEmail("a@" + ".".repeat(200000) + "!"));
timed("email2", () => isValidEmail("a".repeat(200000) + "@"));

assert.strictEqual(trimChar("--a-b--", "-"), "a-b");
assert.strictEqual(trimChar("http://x//", "/", { start: false }), "http://x");
timed("trimChar", () => trimChar("-".repeat(500000) + "x" + "-".repeat(500000), "-"));

const geocode = require("../services/geocode.service");
const oldRe = /^(\d+\s+[^,]+?)\s+([A-Za-z .'-]+)$/;
for (const s of ["123 Main St Chattanooga", "5 Oak Ave Apt Soho", "10 Elm", "Main St 12", "7 a b", "42 Hwy 58 Lookout Mtn", "1 x"]) {
  const old = s.match(oldRe);
  const now = geocode.splitStreetAndCity(s);
  assert.deepStrictEqual(now, old ? [old[1], old[2]] : null, s);
}
assert.strictEqual(geocode.splitStreetAndCity("1 " + "a ".repeat(100000)), null);
timed("geocode", () => geocode.splitStreetAndCity("1 " + "a ".repeat(140) + "1"));

const mkt = require("../services/cloudtakMarketplace.service");
assert.deepStrictEqual(mkt.parseGitHubRepo("https://github.com/acme/plug.git"), { owner: "acme", repo: "plug" });
assert.deepStrictEqual(mkt.parseGitHubRepo("git@github.com:acme/plug"), { owner: "acme", repo: "plug" });
assert.strictEqual(mkt.parseGitHubRepo("https://github.com/acme/plug/tree/x"), null);
timed("parseGitHubRepo", () => mkt.parseGitHubRepo("github.com".repeat(1000) + "/" + "/".repeat(100)));

// ---- regex injection ------------------------------------------------------
assert.strictEqual(escapeRegExp("a(b"), "a\\(b");
const align = require("../services/cloudtakMarketplace.align");
assert.strictEqual(align.hostHasMethod("  foo(\n", "("), false); // would throw "Unterminated group" unescaped
assert.strictEqual(align.hostHasMethod("  connect()\n", "connect"), true);

// ---- HTML sanitizing ------------------------------------------------------
const { stripHtmlTags, decodeBasicEntities } = require("../services/htmlText");
assert.strictEqual(decodeBasicEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;", "no double unescape");
const nested = stripHtmlTags("<scr<script>x</script>ipt>alert(1)</scr</script>ipt>");
assert.ok(!/<script/i.test(nested), "nested tag evasion must not leave a <script tag: " + nested);
assert.strictEqual(stripHtmlTags("<script>evil()</script >ok"), "ok");

const emailTemplates = require("../services/emailTemplates.service");
const text = emailTemplates.htmlToText("<p>Tom &amp;lt; Jerry</p><style>p{}</style><script>x()</script >");
assert.strictEqual(text, "Tom &lt; Jerry");
assert.ok(!/<script/i.test(emailTemplates.htmlToText("<scr<script></script>ipt>alert(1)</scr<script></script>ipt>")));

const mou = fs.readFileSync(path.join(root, "views", "mou_list.ejs"), "utf8");
assert.match(mou, /editVersionKey\.replace\(\/\\\\\/g/, "backslashes are escaped before quotes");

console.log("securityWave3 ok");
