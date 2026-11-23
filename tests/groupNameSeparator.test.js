"use strict";

/**
 * Proof: a group name containing ";", "|" or "," is refused when created or renamed.
 * Portal auth splits X-Authentik-Groups on those characters (Authentik joins names with "|"),
 * so an agency admin who could create "tak_x|<admin group>" and join it was read as a member of
 * the admin group (global admin).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const groups = require("../services/groups.service");
const directoryRepo = require("../services/directoryRepo.service");

const MSG = /cannot contain/;

async function rejects(fn, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a rejection`);
  assert.match(String(err.message), MSG, `${label}: wrong error: ${err.message}`);
}

(async () => {
  // The helper itself.
  for (const bad of ["tak_x|admin", "tak_x;admin", "tak_x,admin", "|", ";a", "a,"]) {
    assert.throws(() => groups.assertGroupNameHasNoSeparator(bad), MSG, bad);
  }
  for (const ok of ["tak_Hamilton Co Sheriff", "tak_A - B (C)", "tak_x/admin", "tak_x:admin", ""]) {
    assert.doesNotThrow(() => groups.assertGroupNameHasNoSeparator(ok), ok);
  }

  // Create: refused before anything is sent to Authentik.
  for (const sep of ["|", ";", ","]) {
    await rejects(() => groups.createGroup(`tak_x${sep}ADMIN_GROUP`), `createGroup with ${JSON.stringify(sep)}`);
  }

  // Rename to a new name with a separator is refused.
  const origGet = directoryRepo.getGroupById;
  directoryRepo.getGroupById = async () => ({ pk: "1", id: "1", name: "tak_Old Name" });
  try {
    for (const sep of ["|", ";", ","]) {
      await rejects(
        () => groups.renameGroup("1", `tak_Old${sep}ADMIN_GROUP`),
        `renameGroup with ${JSON.stringify(sep)}`
      );
    }
  } finally {
    directoryRepo.getGroupById = origGet;
  }

  // Renaming a group whose existing name already has a separator, without changing the name,
  // must not be blocked by this check (so editing its description keeps working).
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "groups.service.js"), "utf8");
  assert.match(src, /if \(n !== oldName\) assertGroupNameHasNoSeparator\(n\);/);

  console.log("groupNameSeparator tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
