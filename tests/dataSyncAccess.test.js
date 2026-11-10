const assert = require("assert");
const {
  resolveMutualAidAllowedGroups,
  resolveManagedMutualAidGroups,
  filterMissionsForAccess,
  canonicalGroupKey,
  resolveGroupsForUser,
  fileSyncNameMatchesMission,
  findMatchingFileSyncPackagesForMission,
  filterDataPackagesForAccess,
  filterFileSyncPackagesForAccess,
} = require("../services/dataSyncAccess.service");
const groupsSvc = require("../services/groups.service");
const packageKind = require("../services/packageKind.service");
const registry = require("../services/permissions.registry");

assert.ok(
  registry.getDefaultSetForRole("agency_admin").has("page.data_package"),
  "agency admins default to page.data_package"
);
assert.ok(
  registry.getDefaultSetForRole("agency_admin").has("page.data_sync"),
  "agency admins default to page.data_sync"
);
assert.strictEqual(
  registry.getPermissionMeta("page.data_package")?.section,
  "operations"
);

const maRecords = [
  {
    id: "ma-1",
    groupId: "uuid-ma-disaster",
    groupName: "MA - Disaster Response",
    username: "ma-disaster",
    createdBy: {
      role: "agency_admin",
      agencySuffixes: ["HCSO"],
    },
    delegatedAgencySuffixes: ["CPD"],
  },
  {
    id: "ma-2",
    groupId: "uuid-ma-linked",
    groupName: "HCSO Shared Channel",
    username: "ma-event",
    createdBy: {
      role: "multi_agency_admin",
      agencySuffixes: ["HCSO", "SHRF"],
    },
    delegatedAgencySuffixes: [],
  },
  {
    id: "ma-3",
    groupId: "uuid-ma-other",
    groupName: "MA - Other Agency",
    username: "ma-other",
    createdBy: {
      role: "agency_admin",
      agencySuffixes: ["OTHER"],
    },
    delegatedAgencySuffixes: [],
  },
];

const allowed = resolveMutualAidAllowedGroups(
  ["tak_MA - Disaster Response", "authentik-HCSO-AgencyAdmin"],
  maRecords
);
assert.strictEqual(allowed.length, 1);
assert.strictEqual(allowed[0].canonicalKey, canonicalGroupKey("MA - Disaster Response"));
assert.strictEqual(allowed[0].mutualAid, true);

const allowedById = resolveMutualAidAllowedGroups(["uuid-ma-linked"], maRecords);
assert.strictEqual(allowedById.length, 1);
assert.strictEqual(allowedById[0].takDisplayName, "HCSO Shared Channel");

// Owner agency admin sees owned MA channel in Data Sync (even without group membership).
const owned = resolveManagedMutualAidGroups(maRecords, (item) => {
  const suffixes = item?.createdBy?.agencySuffixes || [];
  return suffixes.includes("HCSO");
});
assert.strictEqual(owned.length, 2);
assert.ok(owned.some((g) => g.canonicalKey === canonicalGroupKey("MA - Disaster Response")));
assert.ok(owned.some((g) => g.canonicalKey === canonicalGroupKey("HCSO Shared Channel")));
assert.ok(owned.every((g) => g.managed === true && g.mutualAid === true));

// Delegated agency admin sees only delegated MA channel.
const delegated = resolveManagedMutualAidGroups(maRecords, (item) =>
  (item?.delegatedAgencySuffixes || []).includes("CPD")
);
assert.strictEqual(delegated.length, 1);
assert.strictEqual(
  delegated[0].canonicalKey,
  canonicalGroupKey("MA - Disaster Response")
);

// Unrelated agency sees nothing.
const unrelated = resolveManagedMutualAidGroups(maRecords, () => false);
assert.strictEqual(unrelated.length, 0);

const allowedKeySet = new Set([
  canonicalGroupKey("HCSO Main"),
  canonicalGroupKey("MA - Disaster Response"),
]);
const missions = [
  { name: "Agency Mission", groups: ["HCSO Main"] },
  { name: "MA Mission", groups: ["MA - Disaster Response"] },
  { name: "Other Mission", groups: ["Other Group"] },
];
const visible = filterMissionsForAccess(missions, allowedKeySet);
assert.deepStrictEqual(
  visible.map((m) => m.name),
  ["Agency Mission", "MA Mission"]
);

// Permanent delete file-sync name matching must be exact (not prefix/includes).
assert.strictEqual(fileSyncNameMatchesMission("HCSO Ops", "HCSO Ops"), true);
assert.strictEqual(fileSyncNameMatchesMission("HCSO Ops", "HCSO Ops.zip"), true);
assert.strictEqual(fileSyncNameMatchesMission("HCSO Ops", "hcso ops"), true);
assert.strictEqual(
  fileSyncNameMatchesMission("HCSO Ops", "HCSO Ops Extended"),
  false,
  "prefix/startsWith must not match"
);
assert.strictEqual(
  fileSyncNameMatchesMission("Ops", "HCSO Ops"),
  false,
  "substring includes must not match"
);
assert.strictEqual(
  fileSyncNameMatchesMission("TDOT Cameras - Chattanooga", "TDOT Cameras - Chattanooga(1)"),
  false,
  "near-duplicate titles must not match"
);

const deletePkgs = [
  {
    hash: "aaa111",
    filename: "HCSO Ops",
    keywords: [packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION"],
    groups: ["HCSO Main"],
  },
  {
    hash: "bbb222",
    filename: "HCSO Ops Extended",
    keywords: [packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION"],
    groups: ["HCSO Main"],
  },
  {
    hash: "ccc333",
    filename: "Other Mission",
    keywords: [packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION"],
    groups: ["HCSO Main"],
  },
];
const matched = findMatchingFileSyncPackagesForMission(
  "HCSO Ops",
  { contents: [] },
  deletePkgs,
  allowedKeySet,
  {}
);
assert.deepStrictEqual(
  matched.map((p) => p.hash),
  ["aaa111"],
  "delete must only target exact mission name matches"
);

const mixedPackages = [
  {
    hash: "dp-in",
    filename: "Agency Map Pack.zip",
    keywords: [packageKind.PACKAGE_ACTIVE_KEYWORD || "missionpackage"],
    groups: "HCSO Main",
    size: "2MB",
    tool: "public",
  },
  {
    hash: "dp-out",
    filename: "Other Agency Pack.zip",
    keywords: [packageKind.PACKAGE_ACTIVE_KEYWORD || "missionpackage"],
    groups: "Other Group",
    size: "2MB",
    tool: "public",
  },
  {
    hash: "ds-arch",
    filename: "HCSO Ops",
    keywords: [packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION", packageKind.DATA_SYNC_KEYWORD],
    groups: "HCSO Main",
    size: "12kB",
  },
];
const agencyDataPackages = filterDataPackagesForAccess(mixedPackages, allowedKeySet);
assert.deepStrictEqual(
  agencyDataPackages.map((p) => p.hash),
  ["dp-in"],
  "agency data packages must be scoped to allowed groups and exclude data sync rows"
);
const globalDataPackages = filterDataPackagesForAccess(mixedPackages, null);
assert.deepStrictEqual(
  globalDataPackages.map((p) => p.hash).sort(),
  ["dp-in", "dp-out"],
  "global admin sees all data packages but not data sync file-sync rows"
);
const agencyFileSync = filterFileSyncPackagesForAccess(mixedPackages, allowedKeySet);
assert.deepStrictEqual(
  agencyFileSync.map((p) => p.hash),
  ["ds-arch"],
  "data sync file-sync filter remains separate from data packages"
);

(async () => {
  const originalGetGroups = groupsSvc.getGroupsForAuthUser;
  groupsSvc.getGroupsForAuthUser = async () => [
    { name: "tak_Davis Main", pk: "g-davis" },
    { name: "tak_HCSO Ops", pk: "g-hcso" },
  ];
  try {
    const resolved = await resolveGroupsForUser(
      { isGlobalAdmin: true, username: "admin" },
      ["DAVIS Main", "HCSO Ops", "TAK-Only Orphan"]
    );
    assert.strictEqual(resolved.debug.sourceOfTruth, "authentik");
    assert.ok(resolved.groups.includes("Davis Main"), "Authentik spelling must win");
    assert.ok(!resolved.groups.includes("DAVIS Main"), "stale TAK spelling must not override Authentik");
    assert.ok(resolved.groups.includes("HCSO Ops"));
    assert.ok(
      !resolved.groups.includes("TAK-Only Orphan"),
      "TAK-only groups must not appear in the Authentik-backed list"
    );
  } finally {
    groupsSvc.getGroupsForAuthUser = originalGetGroups;
  }

  console.log("dataSyncAccess.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
