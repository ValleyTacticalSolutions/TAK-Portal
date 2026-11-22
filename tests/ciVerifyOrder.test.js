"use strict";

/**
 * Proof: typecheck needs the generated client/map/ported/ files, so build:map must run first
 * in both `npm run verify` and CI. On a clean checkout the other order fails with TS2882.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

const verify = pkg.scripts.verify || "";
assert.ok(
  verify.indexOf("build:map") !== -1 && verify.indexOf("build:map") < verify.indexOf("typecheck"),
  "npm run verify must run build:map before typecheck"
);

const build = ci.indexOf("run: npm run build:map");
const typecheck = ci.indexOf("run: npm run typecheck");
const test = ci.indexOf("run: npm test");
assert.ok(build !== -1 && typecheck !== -1 && test !== -1, "CI must run build:map, typecheck and npm test");
assert.ok(build < typecheck, "CI must run build:map before typecheck");

console.log("ciVerifyOrder.test.js: ok");
