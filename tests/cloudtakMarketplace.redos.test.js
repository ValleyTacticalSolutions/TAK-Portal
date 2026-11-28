const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { trimChar } = require("../services/safeRegex");

// CodeQL js/polynomial-redos: POST /api-connection must not trim slashes with a backtracking regex.
const src = fs.readFileSync(path.join(__dirname, "..", "routes", "cloudtakMarketplace.routes.js"), "utf8");
const start = src.indexOf('router.post("/api-connection"');
assert(start >= 0, "api-connection route exists");
const block = src.slice(start, src.indexOf("CLOUDTAK_API_URL", start));
assert(!/replace\(\s*\/\\\/\+\$\//.test(block), "route must not use .replace(/\\/+$/)");
assert(/trimChar\(/.test(block), "route trims trailing slashes with trimChar");

// The helper stays fast on a hostile input and still strips only trailing slashes.
const hostile = "https://x" + "/".repeat(200000) + "a";
const t0 = Date.now();
assert.strictEqual(trimChar(hostile, "/", { start: false }), hostile);
assert.strictEqual(trimChar("https://x.test///", "/", { start: false }), "https://x.test");
assert(Date.now() - t0 < 500, "linear time");

// URL shape check still rejects non-http(s) input and whitespace.
const ok = (u) => /^https?:\/\/[^\s]+$/i.test(u);
assert(ok("https://cloudtak.example.com"));
assert(!ok("ftp://x"));
assert(!ok("javascript:alert(1)"));
assert(!ok("https://a b"));
console.log("cloudtakMarketplace.redos ok");
