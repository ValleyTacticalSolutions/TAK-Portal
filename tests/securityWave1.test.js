"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { shellQuote, shellJoin, assertShellToken } = require("../services/shellQuote");
const remoteSvc = require("../services/takSsh.service");
const marketplaceRemote = require("../services/cloudtakMarketplace.ssh");
const qrSvc = require("../services/qr.service");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// 1. Command injection: metacharacters reach the command as literal text.
const nasty = ["a; touch /tmp/pwned_$$", "$(id)", "`id`", "x' ; echo 'y", "a && b | c\nd", ""];
for (const v of nasty) {
  const out = execFileSync("bash", ["-c", `printf %s ${shellQuote(v)}`]).toString();
  assert.strictEqual(out, v, `shellQuote must pass ${JSON.stringify(v)} literally`);
}
assert.strictEqual(marketplaceRemote.shellQuote("a;b"), shellQuote("a;b"), "marketplace uses the shared helper");
assert.strictEqual(
  execFileSync("bash", ["-c", `printf '%s|' ${shellJoin(["$(id)", "a b", "`x`"])}`]).toString(),
  "$(id)|a b|`x`|"
);
assert.throws(() => assertShellToken("tak; id", "user"));
assert.throws(() => assertShellToken("$(id)", "user"));
assert.strictEqual(assertShellToken("tak"), "tak");
assert.throws(
  () => remoteSvc.buildPrivilegedCommand("id", { mode: "nopasswd" }, { runAsUser: "tak; touch /tmp/x" }),
  /Unsupported characters/
);
assert.ok(
  remoteSvc.buildPrivilegedCommand("id", { mode: "nopasswd" }, { runAsUser: "tak" }).includes("-u tak id")
);

// 2. Weak randomness: no Math.random in server code.
(function scan(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) scan(rel);
    else if (e.name.endsWith(".js") && e.name !== "randomId.js") {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!/Math\.random\(/.test(code), `Math.random in ${rel}`);
    }
  }
})("routes");
(function scanServices() {
  for (const e of fs.readdirSync(path.join(root, "services"))) {
    if (!e.endsWith(".js") || e === "randomId.js") continue;
    const code = read(path.join("services", e)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/Math\.random\(/.test(code), `Math.random in services/${e}`);
  }
})();
const { timeId } = require("../services/randomId");
assert.notStrictEqual(timeId(), timeId());
assert.ok(/^[a-z0-9]+-[0-9a-f]{8}$/.test(timeId()));

// 3. QR cache key is a scrypt derivation, not a bare SHA-256 of the content.
const url = "tak://x?password=secret";
const key = qrSvc.displayQrCacheKey(url);
assert.ok(/^[0-9a-f]{64}$/.test(key));
assert.strictEqual(key, qrSvc.displayQrCacheKey(url));
assert.ok(/scryptSync/.test(read("services/qr.service.js")));
assert.ok(!/createHash\("sha256"\)/.test(read("services/qr.service.js")));

// 4. Format strings are fixed; loops are bounded; request keys can't pollute prototypes.
for (const [f, needle] of [
  ["services/groupRenamePropagate.service.js", "for user ${id}:`"],
  ["services/dashboardStatsCache.service.js", "refresh failed (${name}):`"],
  ["routes/integrations.routes.js", 'data feed "${dataFeedName}" for "${un}":`'],
  ["routes/integrations.routes.js", 'probe failed for "${dataFeedName}"'],
]) {
  assert.ok(!read(f).includes(needle), `user data in a log format string in ${f}`);
}

assert.ok(/Object\.create\(null\)/.test(read("routes/mou.routes.js")));
assert.ok(/RESERVED_OBJECT_KEYS/.test(read("routes/mou.routes.js")));
assert.ok(/clientSafeErrorMessage/.test(read("routes/mou.routes.js")));
assert.ok(/MAX_IMPORT_CSV_LINES/.test(read("routes/agencies.routes.js")));
assert.ok(/slice\(0, 20000\)/.test(read("services/users.service.js")));

console.log("securityWave1.test.js: ok");
