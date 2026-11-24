const assert = require("assert");
const fs = require("fs");
const path = require("path");

const view = fs.readFileSync(path.join(__dirname, "..", "views", "cloudtak-marketplace.ejs"), "utf8");

// #183: a tab left open after the login lapses must stop polling, not hit the sign-in redirect forever.
assert(/function stopJobPoll\(\)/.test(view), "stopJobPoll helper exists");
assert(/r\.redirected/.test(view), "poll detects a login redirect");
assert(/r\.status === 401/.test(view), "poll detects 401");
assert(/Session expired, please reload/.test(view), "shows a session expired message");
assert(/expired:\s*true/.test(view), "readJson flags expired responses");
assert(/snapRes\.expired \|\| statusRes\.expired/.test(view), "loadAll stops on expired");
assert(/POLL_MAX_FAILURES/.test(view), "repeated failures stop the poll");
assert(/pollFailures < POLL_MAX_FAILURES/.test(view), "poll only continues below the failure cap");
console.log("cloudtakMarketplace.issue183 ok");
