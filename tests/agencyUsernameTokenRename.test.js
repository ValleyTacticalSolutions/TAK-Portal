/**
 * Agency username token (prefix/suffix) rename: future-only re-key, replace-all
 * preflight/collision, no-op, and UI/API wiring proof.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pgCache = require("../services/pgCache");
const accessSvc = require("../services/access.service");
const renameSvc = require("../services/agencyUsernameTokenRename.service");

const originalTemplates = pgCache.caches.templates;
const originalRequests = pgCache.caches.userRequests;
const originalAgencies = pgCache.caches.agencies;

function restoreCaches() {
  pgCache.caches.templates = originalTemplates;
  pgCache.caches.userRequests = originalRequests;
  pgCache.caches.agencies = originalAgencies;
}

(async () => {
try {
  // --- validation ---
  assert.ok(renameSvc.validateNewUsernameToken(""));
  assert.ok(renameSvc.validateNewUsernameToken("bad token"));
  assert.strictEqual(renameSvc.validateNewUsernameToken("abcd"), null);

  // --- username rebuild placement ---
  assert.strictEqual(
    accessSvc.buildUsernameWithAgencyToken("1234", { suffix: "hs", usernameTokenPlacement: "suffix" }),
    "1234hs"
  );
  assert.strictEqual(
    accessSvc.buildUsernameWithAgencyToken("1234", { suffix: "hs", usernameTokenPlacement: "prefix" }),
    "hs1234"
  );
  assert.strictEqual(
    accessSvc.buildUsernameWithAgencyToken("1234", { suffix: "cfd", usernameTokenPlacement: "suffix" }),
    "1234cfd"
  );

  // --- template + request re-key helpers ---
  pgCache.caches.templates = [
    { name: "Firefighter", agencySuffix: "cfd", isDefault: true },
    { name: "Medic", agencySuffix: "ems", isDefault: false },
  ];
  pgCache.caches.userRequests = [
    { id: 1, agencySuffix: "cfd", badgeNumber: "100" },
    { id: 2, agencySuffix: "ems", badgeNumber: "200" },
  ];

  const tpl = renameSvc.updateTemplatesAgencySuffix("cfd", "cfdfd");
  assert.strictEqual(tpl.templatesUpdated, 1);
  assert.strictEqual(pgCache.caches.templates[0].agencySuffix, "cfdfd");
  assert.strictEqual(pgCache.caches.templates[1].agencySuffix, "ems");

  const req = renameSvc.updateUserRequestsAgencySuffix("cfd", "cfdfd");
  assert.strictEqual(req.requestsUpdated, 1);
  assert.strictEqual(pgCache.caches.userRequests[0].agencySuffix, "cfdfd");
  assert.strictEqual(pgCache.caches.userRequests[1].agencySuffix, "ems");

  const tplNoop = renameSvc.updateTemplatesAgencySuffix("cfd", "cfd");
  assert.strictEqual(tplNoop.templatesUpdated, 0);

  // --- buildExistingRenamePlan: happy path + collision ---
  const directoryRepo = require("../services/directoryRepo.service");
  const originalGetByUsername = directoryRepo.getUserByUsername;

  const oldAgency = { suffix: "hs", usernameTokenPlacement: "suffix" };
  const newAgency = { suffix: "hcso", usernameTokenPlacement: "suffix" };
  const users = [
    {
      id: "u1",
      uuid: "u1",
      username: "1234hs",
      attributes: { badge_number: "1234", agency: "hs" },
    },
    {
      id: "u2",
      uuid: "u2",
      username: "5678hs",
      attributes: { badge_number: "5678", agency: "hs" },
    },
  ];

  directoryRepo.getUserByUsername = async () => null;
  const plans = await renameSvc.buildExistingRenamePlan(users, oldAgency, newAgency);
  assert.strictEqual(plans.length, 2);
  assert.strictEqual(plans[0].newUsername, "1234hcso");
  assert.strictEqual(plans[1].newUsername, "5678hcso");
  assert.strictEqual(plans[0].usernameChanged, true);

  // Placement flip
  const prefixAgency = { suffix: "hs", usernameTokenPlacement: "prefix" };
  const plansPrefix = await renameSvc.buildExistingRenamePlan(
    users,
    oldAgency,
    prefixAgency
  );
  assert.strictEqual(plansPrefix[0].newUsername, "hs1234");

  // Collision with outside user
  directoryRepo.getUserByUsername = async (uname) => {
    if (String(uname).toLowerCase() === "1234hcso") {
      return { id: "other", uuid: "other", username: "1234hcso" };
    }
    return null;
  };
  let collided = false;
  try {
    await renameSvc.buildExistingRenamePlan(users, oldAgency, newAgency);
  } catch (err) {
    collided = /already exists/i.test(String(err?.message || ""));
  }
  assert.ok(collided, "collision with outside username must abort");

  // Missing badge aborts
  let missingBadge = false;
  try {
    await renameSvc.buildExistingRenamePlan(
      [{ id: "x", uuid: "x", username: "mystery", attributes: {} }],
      oldAgency,
      newAgency
    );
  } catch (err) {
    missingBadge = /badge/i.test(String(err?.message || ""));
  }
  assert.ok(missingBadge, "missing badge must abort");

  directoryRepo.getUserByUsername = originalGetByUsername;

  // --- no-op rename when token+placement unchanged ---
  pgCache.caches.agencies = [
    {
      name: "Test Agency",
      suffix: "hs",
      groupPrefix: "HS",
      usernameTokenPlacement: "suffix",
    },
  ];
  const agenciesStore = require("../services/agencies.service");
  const originalLoad = agenciesStore.load;
  const originalSave = agenciesStore.save;
  agenciesStore.load = () => pgCache.caches.agencies;
  agenciesStore.save = (list) => {
    pgCache.caches.agencies = list;
  };

  const listUsersOrig = directoryRepo.listUsersByAgencySuffix;
  directoryRepo.listUsersByAgencySuffix = async () => [];

  const skipped = await renameSvc.renameAgencyUsernameToken(0, {
    suffix: "hs",
    usernameTokenPlacement: "suffix",
    scope: "future",
  });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.usersUpdated, 0);

  // --- future-only: placement change updates agency, no user rename path ---
  const future = await renameSvc.renameAgencyUsernameToken(0, {
    suffix: "hs",
    usernameTokenPlacement: "prefix",
    scope: "future",
  });
  assert.strictEqual(future.skipped, false);
  assert.strictEqual(future.scope, "future");
  assert.strictEqual(future.newPlacement, "prefix");
  assert.strictEqual(future.oldPlacement, "suffix");
  assert.strictEqual(pgCache.caches.agencies[0].usernameTokenPlacement, "prefix");
  assert.strictEqual(future.usersRenamed || 0, 0);

  // --- future-only suffix change re-keys templates/requests ---
  pgCache.caches.templates = [{ name: "A", agencySuffix: "hs" }];
  pgCache.caches.userRequests = [{ id: 9, agencySuffix: "hs" }];
  const updateSuffixOrig = directoryRepo.updateUsersAgencySuffixColumn;
  directoryRepo.updateUsersAgencySuffixColumn = async () => [];
  const futureSuffix = await renameSvc.renameAgencyUsernameToken(0, {
    suffix: "hcso",
    usernameTokenPlacement: "prefix",
    scope: "future",
  });
  assert.strictEqual(futureSuffix.newSuffix, "hcso");
  assert.strictEqual(pgCache.caches.agencies[0].suffix, "hcso");
  assert.strictEqual(pgCache.caches.templates[0].agencySuffix, "hcso");
  assert.strictEqual(pgCache.caches.userRequests[0].agencySuffix, "hcso");

  directoryRepo.updateUsersAgencySuffixColumn = updateSuffixOrig;
  directoryRepo.listUsersByAgencySuffix = listUsersOrig;
  agenciesStore.load = originalLoad;
  agenciesStore.save = originalSave;

  // --- wiring proof ---
  const routesSrc = fs.readFileSync(
    path.join(__dirname, "..", "routes", "agencies.routes.js"),
    "utf8"
  );
  assert.ok(
    routesSrc.includes('router.post("/:index/rename-username-token"'),
    "agencies routes must expose rename-username-token"
  );
  assert.ok(
    routesSrc.includes("RENAME_AGENCY_USERNAME_TOKEN"),
    "rename-username-token must audit"
  );

  const viewSrc = fs.readFileSync(
    path.join(__dirname, "..", "views", "agencies.ejs"),
    "utf8"
  );
  assert.ok(
    viewSrc.includes("usernameTokenConfirmOverlay"),
    "edit modal must prompt for username token change scope"
  );
  assert.ok(
    viewSrc.includes("rename-username-token"),
    "agencies UI must call rename-username-token"
  );
  assert.ok(
    /usernameReadOnly:\s*false/.test(viewSrc),
    "edit agency form must allow editing username token fields"
  );

  const emailTpl = path.join(
    __dirname,
    "..",
    "email_templates",
    "agency_username_changed.html"
  );
  assert.ok(fs.existsSync(emailTpl), "agency_username_changed.html must exist");
  const emailHtml = fs.readFileSync(emailTpl, "utf8");
  assert.ok(emailHtml.includes("{{oldUsername}}"));
  assert.ok(emailHtml.includes("{{newUsername}}"));

  const settingsSrc = fs.readFileSync(
    path.join(__dirname, "..", "views", "settings.ejs"),
    "utf8"
  );
  assert.ok(settingsSrc.includes("agency_username_changed.html"));

  const usersSrc = fs.readFileSync(
    path.join(__dirname, "..", "services", "users.service.js"),
    "utf8"
  );
  assert.ok(usersSrc.includes("emailAgencyUsernameChanged"));

  const renameSrc = fs.readFileSync(
    path.join(__dirname, "..", "services", "agencyUsernameTokenRename.service.js"),
    "utf8"
  );
  assert.ok(renameSrc.includes("revokeCertsForUsersBulk"));
  assert.ok(renameSrc.includes('scope === "existing"'));
  assert.ok(
    renameSrc.includes("forceNoLoginsStatusForUserIds"),
    "replace-all must force No Logins status after cert revoke"
  );

  const statusSrc = fs.readFileSync(
    path.join(__dirname, "..", "services", "userLoginStatus.service.js"),
    "utf8"
  );
  assert.ok(statusSrc.includes("forceNoLoginsStatusForUserIds"));
  assert.ok(
    /forceNoLoginsStatusForUserIds[\s\S]*last_login\s*=\s*null/.test(statusSrc),
    "force No Logins must clear last_login so status is not Web Only"
  );
  assert.ok(
    /forceNoLoginsStatusForUserIds[\s\S]*has_active_tak_cert\s*=\s*false/.test(statusSrc),
    "force No Logins must clear has_active_tak_cert"
  );

  console.log("agencyUsernameTokenRename.test.js: ok");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  restoreCaches();
}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
