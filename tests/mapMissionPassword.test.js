const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "routes", "map.routes.js"), "utf8");

assert(!/req\.query\.password/.test(src), "mission password must not be read from the query string");
assert(/x-mission-password/i.test(src), "mission password must come from the X-Mission-Password header");
assert.strictEqual((src.match(/const missionPassword = missionPasswordFromHeader\(req\)/g) || []).length, 3);
console.log("mapMissionPassword ok");
