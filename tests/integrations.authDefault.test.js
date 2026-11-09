const assert = require("assert");
const fs = require("fs");
const path = require("path");

const routesPath = path.join(__dirname, "..", "routes", "integrations.routes.js");
const viewPath = path.join(__dirname, "..", "views", "integrations.ejs");
const routesSrc = fs.readFileSync(routesPath, "utf8");
const viewSrc = fs.readFileSync(viewPath, "utf8");

assert.ok(
  /auth:\s*authType\s*\|\|\s*"ANONYMOUS"/.test(routesSrc),
  "new integration data feeds must default authType to ANONYMOUS"
);
assert.ok(
  /auth:\s*src\.auth\s*\|\|\s*"ANONYMOUS"/.test(routesSrc),
  "dataFeedWritePayload must default auth to ANONYMOUS"
);
assert.ok(
  !/authType\s*\|\|\s*"X_509"/.test(routesSrc),
  "integration create paths must not default authType to X_509"
);

assert.ok(
  /<option value="ANONYMOUS" selected>Anonymous<\/option>/.test(viewSrc),
  "integrations form must select Anonymous by default"
);
assert.ok(
  !/<option value="X_509" selected>/.test(viewSrc),
  "integrations form must not select X.509 by default"
);

console.log("integrations.authDefault.test.js: ok");
