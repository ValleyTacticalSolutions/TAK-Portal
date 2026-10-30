"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const routesSrc = fs.readFileSync(
  path.join(__dirname, "..", "routes", "dataSync.routes.js"),
  "utf8"
);

assert.match(routesSrc, /missionExistsStrict/);
assert.match(routesSrc, /MISSION_EXISTS/);
assert.match(routesSrc, /intent === "create" && existedBefore/);
assert.match(
  routesSrc,
  /if \(existedBefore\)[\s\S]*?assertMissionReadable/,
  "PUT must require readable access when the mission already exists"
);

const putFn = routesSrc.slice(
  routesSrc.indexOf('router.put("/missions/:missionName"'),
  routesSrc.indexOf('router.post("/missions/:missionName"')
);
assert.match(putFn, /assertMissionReadable/);
assert.match(putFn, /MISSION_EXISTS/);
assert.doesNotMatch(
  putFn,
  /existedBefore = await missionExists\(/,
  "PUT create gate must use fail-closed missionExistsStrict, not soft missionExists"
);

console.log("dataSync.missionCreateGate.test.js: ok");
