"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const syncSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directorySync.service.js"),
  "utf8"
);
const usersSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "users.service.js"),
  "utf8"
);

assert.match(syncSrc, /resolveSyncedAuthentikGroupPks/);
assert.match(syncSrc, /persistUserAuthentikPk/);
assert.match(syncSrc, /findAuthentikUserByUsername/);
assert.match(syncSrc, /findAuthentikGroupByName/);
assert.match(
  syncSrc,
  /Persist pk immediately|persistUserAuthentikPk\(row\.entity_id,\s*pk\)/
);
assert.match(syncSrc, /unique\|already exists\|username/i);
assert.match(syncSrc, /already exists\|unique\|name/i);
assert.match(
  syncSrc,
  /deleteLocalGroup\(row\.entity_id\)/,
  "#141: create_group must drop orphan when authentik_pk already owned"
);
assert.match(
  syncSrc,
  /groups_authentik_pk_key|authentik_pk = \$1 AND id <> \$2/,
  "#141: create_group must detect duplicate authentik_pk ownership"
);
assert.doesNotMatch(
  syncSrc.match(/kind === "create_user"[\s\S]*?kind === "set_password"/)[0],
  /filter\(\(x\) => repo\.isAuthentikPkToken\(x\)\)/,
  "create_user must not treat local UUIDs as Authentik group pks"
);

const resetFn = usersSrc.slice(
  usersSrc.indexOf("async function resetPassword"),
  usersSrc.indexOf("async function resendOnboardingEmail")
);
assert.match(resetFn, /still syncing to Authentik/);
assert.match(resetFn, /authentik_pk == null/);

console.log("directoryOutbox.createUser.test.js: ok");
