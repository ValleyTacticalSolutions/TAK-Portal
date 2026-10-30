"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const routesSrc = fs.readFileSync(
  path.join(__dirname, "..", "routes", "groups.routes.js"),
  "utf8"
);
const groupsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "groups.service.js"),
  "utf8"
);
const repoSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directoryRepo.service.js"),
  "utf8"
);
const uiSrc = fs.readFileSync(path.join(__dirname, "..", "views", "groups.ejs"), "utf8");

const patchFn = routesSrc.slice(
  routesSrc.indexOf('router.patch("/:groupId"'),
  routesSrc.indexOf("Impact preview before delete")
);
assert.match(patchFn, /groupType/);
assert.match(patchFn, /groupTypeDetail/);
assert.match(patchFn, /canUserModifyGroup/);
assert.match(patchFn, /Global groups cannot start with "MA -/);
assert.match(patchFn, /not allowed to change an agency group/);

assert.match(groupsSrc, /applyGroupEditAttributes/);
const utilSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "groupTypeEdit.util.js"),
  "utf8"
);
assert.match(utilSrc, /created_type_detail = detail \|\| ""/);
assert.match(utilSrc, /gt !== "Agency"/);
assert.match(utilSrc, /wantsGroupType/);

assert.match(
  repoSrc,
  /created_type_detail = CASE WHEN \$4::jsonb IS NULL THEN created_type_detail ELSE \$6 END/,
  "updateLocalGroup must allow clearing created_type_detail (no COALESCE)"
);
assert.match(
  repoSrc,
  /created_type = CASE WHEN \$4::jsonb IS NULL THEN created_type ELSE \$5 END/
);

assert.match(uiSrc, /deriveGroupTypePayload/);
assert.match(uiSrc, /resolveEditUiType/);
assert.match(uiSrc, /groupType,/);
assert.match(uiSrc, /groupTypeDetail/);
assert.match(
  uiSrc,
  /!IS_GLOBAL_ADMIN && type !== "agency"/,
  "agency admins must still be blocked from type conversion"
);
assert.match(
  uiSrc,
  /editAgencyPrefixSelect\.disabled = !IS_MULTI_AGENCY_ADMIN/,
  "multi-agency admins may reassign among managed agencies"
);

const saveChunk = uiSrc.slice(
  uiSrc.indexOf("editGroupSaveBtn.onclick"),
  uiSrc.indexOf("if (editGroupCloseBtn)")
);
assert.match(saveChunk, /groupType/);
assert.match(saveChunk, /groupTypeDetail/);
assert.match(saveChunk, /typeUnchanged/);
assert.match(
  saveChunk,
  /newPrivate = "no"/,
  "leaving agency type must clear hide-from-agency-admins"
);

console.log("groupsEditType.test.js: ok");
