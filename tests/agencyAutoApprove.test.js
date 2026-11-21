const assert = require("assert");
const pgCache = require("../services/pgCache");
const templatesSvc = require("../services/templates.service");
const agenciesSvc = require("../services/agencies.service");
const { shouldAutoApproveRequest } = require("../services/userRequests.service");

const originalTemplates = pgCache.caches.templates;
pgCache.caches.templates = [
  { name: "Firefighter", agencySuffix: "cfd", isDefault: true },
  { name: "Officer", agencySuffix: "cfd", isDefault: false },
  { name: "Medic", agencySuffix: "ems", isDefault: false },
];

try {
  const def = templatesSvc.getDefaultTemplateForAgency("CFD");
  assert.ok(def);
  assert.strictEqual(def.name, "Firefighter");
  assert.strictEqual(templatesSvc.getDefaultTemplateForAgency("ems"), null);
  assert.strictEqual(templatesSvc.getDefaultTemplateForAgency(""), null);

  agenciesSvc.assertAgencyCanEnableAutoApprove({
    suffix: "cfd",
    lookupDomain: "agency.gov",
  });
  assert.throws(
    () =>
      agenciesSvc.assertAgencyCanEnableAutoApprove({
        suffix: "cfd",
        lookupDomain: "",
      }),
    /email domain/i
  );
  assert.throws(
    () =>
      agenciesSvc.assertAgencyCanEnableAutoApprove({
        suffix: "ems",
        lookupDomain: "ems.gov",
      }),
    /default template/i
  );

  const agencyOn = {
    suffix: "cfd",
    autoApproveRequests: true,
    lookupDomain: "agency.gov, county.org",
  };
  const validatedMatch = {
    agencySuffix: "cfd",
    email: "user@agency.gov",
  };
  const validatedMiss = {
    agencySuffix: "cfd",
    email: "user@gmail.com",
  };
  assert.strictEqual(shouldAutoApproveRequest(agencyOn, validatedMatch), true);
  assert.strictEqual(shouldAutoApproveRequest(agencyOn, validatedMiss), false);

  const agencyNoDomain = {
    suffix: "cfd",
    autoApproveRequests: true,
    lookupDomain: "",
  };
  assert.strictEqual(
    shouldAutoApproveRequest(agencyNoDomain, { agencySuffix: "cfd", email: "anyone@gmail.com" }),
    false
  );

  const agencyOff = { suffix: "cfd", autoApproveRequests: false, lookupDomain: "agency.gov" };
  assert.strictEqual(
    shouldAutoApproveRequest(agencyOff, { agencySuffix: "cfd", email: "user@agency.gov" }),
    false
  );

  const noDefaultAgency = {
    suffix: "ems",
    autoApproveRequests: true,
    lookupDomain: "ems.gov",
  };
  assert.strictEqual(
    shouldAutoApproveRequest(noDefaultAgency, { agencySuffix: "ems", email: "user@ems.gov" }),
    false
  );

  assert.strictEqual(
    shouldAutoApproveRequest(agencyOn, { agencySuffix: "__other__", email: "user@agency.gov" }),
    false
  );

  const withDomain = { autoApproveRequests: true, lookupDomain: "agency.gov" };
  assert.strictEqual(agenciesSvc.syncAutoApproveForMissingDomains(withDomain), false);
  assert.strictEqual(withDomain.autoApproveRequests, true);

  const cleared = { autoApproveRequests: true, lookupDomain: "" };
  assert.strictEqual(agenciesSvc.syncAutoApproveForMissingDomains(cleared), true);
  assert.strictEqual(cleared.autoApproveRequests, false);

  console.log("agencyAutoApprove.test.js: ok");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  pgCache.caches.templates = originalTemplates;
}
