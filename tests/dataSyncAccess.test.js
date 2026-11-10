const assert = require("assert");
const {
  resolveMutualAidAllowedGroups,
  resolveManagedMutualAidGroups,
  filterMissionsForAccess,
  canonicalGroupKey,
  resolveGroupsForUser,
} = require("../services/dataSyncAccess.service");
const groupsSvc = require("../services/groups.service");

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
