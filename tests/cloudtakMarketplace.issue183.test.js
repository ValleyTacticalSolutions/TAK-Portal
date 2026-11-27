const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const view = fs.readFileSync(path.join(__dirname, "..", "views", "cloudtak-marketplace.ejs"), "utf8").replace(/\r\n/g, "\n");

// #183: a tab left open after the login lapses must stop polling, not hit the sign-in redirect forever.
function grab(name) {
  const m = view.match(new RegExp("  function " + name + "\\([\\s\\S]*?\\n  \\}\\n"));
  assert(m, name + " exists in the view");
  return m[0];
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  "var POLL_MAX_FAILURES = 5; var POLL_MAX_NETWORK_FAILURES_BUSY = 90;" +
    grab("isExpiredResponse") + grab("nextPollFailures") + grab("pollFailureCap"),
  ctx
);
const hdr = (ct) => ({ get: () => ct });

// Behavior: expired-login responses are detected.
assert.strictEqual(ctx.isExpiredResponse({ redirected: true, status: 200, ok: true, headers: hdr("text/html") }), true);
assert.strictEqual(ctx.isExpiredResponse({ redirected: false, status: 401, ok: false, headers: hdr("application/json") }), true);
assert.strictEqual(ctx.isExpiredResponse({ redirected: false, status: 403, ok: false, headers: hdr("application/json") }), true);
assert.strictEqual(ctx.isExpiredResponse({ redirected: false, status: 200, ok: true, headers: hdr("text/html; charset=utf-8") }), true);
// Normal and server-error JSON responses are not "expired".
assert.strictEqual(ctx.isExpiredResponse({ redirected: false, status: 200, ok: true, headers: hdr("application/json; charset=utf-8") }), false);
assert.strictEqual(ctx.isExpiredResponse({ redirected: false, status: 502, ok: false, headers: hdr("text/html") }), false);

// Behavior: failures count up when idle, reset on success, and never count during a running job.
assert.strictEqual(ctx.nextPollFailures(2, true, false), 3);
assert.strictEqual(ctx.nextPollFailures(4, false, false), 0);
assert.strictEqual(ctx.nextPollFailures(4, true, true), 4, "server restart mid-install must not stop the poll");

// Behavior: a blocked login redirect (rejected fetch) during a job still hits a cap and stops polling.
assert.strictEqual(ctx.nextPollFailures(4, true, true, true), 5, "network errors count even while a job is busy");
let n = 0;
let polls = 0;
while (n < ctx.pollFailureCap(true)) { n = ctx.nextPollFailures(n, true, true, true); polls++; }
assert(polls <= 90 && polls > 5, "busy network failures stop polling after a bounded number of tries");
assert.strictEqual(ctx.pollFailureCap(false), 5);
// 5xx with a JSON body during a job still never counts.
assert.strictEqual(ctx.nextPollFailures(3, true, true, false), 3);

// Wiring: the poll uses the helpers and stops on expiry or the failure cap.
assert(/snapRes\.expired \|\| statusRes\.expired/.test(view), "loadAll stops on expired");
assert(/jobBusy && pollFailures < pollFailureCap\(true\)/.test(view), "poll continues only below the failure cap");
assert(/nextPollFailures\(pollFailures, true, jobBusy, true\);\s*if \(pollFailures >= pollFailureCap\(jobBusy\)\)/.test(view), "catch path counts network errors during a job");
assert(/Session expired, please reload/.test(view), "shows a session expired message");
console.log("cloudtakMarketplace.issue183 ok");
