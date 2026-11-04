/**
 * Proof: Agencies Save and Agency Admin assign ensure the Authentik AgencyAdmin
 * group exists (edit Save no longer hits PUT /:index which used to ensure it).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const agencyAdminGroupSvc = require("../services/agencyAdminGroup.service");

assert.strictEqual(
  agencyAdminGroupSvc.getAgencyAdminGroupName({
    groupPrefix: "COSH",
    countyAbbrev: "WIL",
  }),
  "authentik-WIL-COSH-AgencyAdmin"
);
assert.strictEqual(
  agencyAdminGroupSvc.getAgencyAdminGroupName({
    groupPrefix: "COSH",
    countyAbbrev: "",
  }),
  "authentik-COSH-AgencyAdmin"
);

const agenciesRoutes = fs.readFileSync(
  path.join(__dirname, "..", "routes", "agencies.routes.js"),
  "utf8"
);
assert.ok(
  agenciesRoutes.includes('router.post("/:index/ensure-admin-group"'),
  "agencies routes must expose POST /:index/ensure-admin-group"
);
assert.ok(
  agenciesRoutes.includes("agencyAdminGroup.service"),
  "agencies routes must use shared agencyAdminGroup.service"
);

const agenciesView = fs.readFileSync(
  path.join(__dirname, "..", "views", "agencies.ejs"),
  "utf8"
);
assert.ok(
  agenciesView.includes("ensure-admin-group"),
  "Agencies Save Changes must call ensure-admin-group"
);
assert.ok(
  /finishAgencyAttributesEditing[\s\S]*ensure-admin-group/.test(agenciesView),
  "ensure-admin-group must run from finishAgencyAttributesEditing (Save Changes)"
);

const accessSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "access.service.js"),
  "utf8"
);
const syncStart = accessSrc.indexOf("async function syncPortalRoleGroups");
assert.ok(syncStart >= 0, "syncPortalRoleGroups missing");
const syncFn = accessSrc.slice(
  syncStart,
  accessSrc.indexOf("function getManagedAgencySuffixesFromGroupNames")
);
assert.ok(
  syncFn.includes("ensureAgencyAdminGroupsForSuffixes"),
  "syncPortalRoleGroups must ensure AgencyAdmin groups before assigning"
);

const usersSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "users.service.js"),
  "utf8"
);
assert.ok(
  usersSrc.includes("ensureAgencyAdminGroupsForSuffixes"),
  "createUser Agency Admin path must ensure missing AgencyAdmin groups"
);

console.log("agencyAdminGroupEnsure.test.js: ok");
