const assert = require("assert");
const fs = require("fs");
const path = require("path");

const routesPath = path.join(__dirname, "..", "routes", "integrations.routes.js");
const viewPath = path.join(__dirname, "..", "views", "integrations.ejs");
const routesSrc = fs.readFileSync(routesPath, "utf8");
const viewSrc = fs.readFileSync(viewPath, "utf8");

assert.ok(
  /auth:\s*authType\s*\|\|\s*"X_509"/.test(routesSrc),
  "new integration data feeds must default authType to X_509"
);
assert.ok(
  /auth:\s*src\.auth\s*\|\|\s*"X_509"/.test(routesSrc),
  "dataFeedWritePayload must default auth to X_509"
);
assert.ok(
  !/authType\s*\|\|\s*"ANONYMOUS"/.test(routesSrc),
  "integration create paths must not default authType to ANONYMOUS"
);

assert.ok(
  /<option value="X_509" selected>X\.509<\/option>/.test(viewSrc),
  "integrations form must select X.509 by default"
);
assert.ok(
  !/<option value="ANONYMOUS" selected>/.test(viewSrc),
  "integrations form must not select Anonymous by default"
);

console.log("integrations.authDefault.test.js: ok");
