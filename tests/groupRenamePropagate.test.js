"use strict";

const assert = require("assert");
const propagate = require("../services/groupRenamePropagate.service");

(function testRewriteGroupList() {
  const map = propagate.normalizeRenameMap("tak_Old Ops", "New Ops");
  const { next, changed } = propagate.rewriteGroupList(
    ["tak_Old Ops", "Other Channel", "Old Ops"],
    map
  );
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(next, ["New Ops", "Other Channel"]);

  const noop = propagate.rewriteGroupList(["Other Channel"], map);
  assert.strictEqual(noop.changed, false);
  assert.deepStrictEqual(noop.next, ["Other Channel"]);
})();

(function testNormalizeRenameMapFromObjectAndMap() {
  const fromPair = propagate.normalizeRenameMap("Alpha Main", "Beta Main");
  assert.strictEqual(fromPair.get("alpha main"), "Beta Main");

  const fromMap = propagate.normalizeRenameMap(
    new Map([
      ["tak_Old A", "New A"],
      ["Old B", "New B"],
    ])
  );
  assert.strictEqual(fromMap.get("old a"), "New A");
  assert.strictEqual(fromMap.get("old b"), "New B");

  const same = propagate.normalizeRenameMap("Same", "tak_Same");
  assert.strictEqual(same.size, 0);
})();

(async function testPropagateUpdatesMissionsAndPackages() {
  const prevTakUrl = process.env.TAK_URL;
  const prevBypass = process.env.TAK_BYPASS_ENABLED;
  process.env.TAK_URL = process.env.TAK_URL || "https://tak.test.example";
  delete process.env.TAK_BYPASS_ENABLED;

  const dataSyncSvc = require("../services/dataSync.service");
  const dataPackagesSvc = require("../services/dataPackages.service");
  const channelPatchStore = require("../services/channelPatch.store");
  const mutualAidStore = require("../services/mutualAid.store");
  const usersSvc = require("../services/users.service");

  const missionWrites = [];
  const packageWrites = [];
  const patchUpdates = [];
  let mutualAidSaved = null;
  const userAttrPatches = [];

  const orig = {
    listMissions: dataSyncSvc.listMissions,
    changeMission: dataSyncSvc.changeMission,
    listPackages: dataPackagesSvc.listDataPackages,
    updateMeta: dataPackagesSvc.updateDataPackageMetadata,
    listPatches: channelPatchStore.list,
    updatePatch: channelPatchStore.update,
    maLoad: mutualAidStore.load,
    maSave: mutualAidStore.save,
    getUser: usersSvc.getUserById,
    enqueueAttrs: usersSvc.enqueueLocalUserAttributePatch,
  };

  dataSyncSvc.listMissions = async () => ({
    data: [
      {
        name: "Ops Mission",
        groups: ["Old Ops", "Keep Me"],
        tool: "public",
        description: "",
        defaultRole: { type: "MISSION_SUBSCRIBER" },
        keywords: [],
      },
      {
        name: "Untouched",
        groups: ["Other Channel"],
        tool: "public",
        description: "",
        defaultRole: { type: "MISSION_SUBSCRIBER" },
        keywords: [],
      },
    ],
  });
  dataSyncSvc.changeMission = async (name, body) => {
    missionWrites.push({ name, groups: body.groups.slice() });
    return {};
  };
  dataPackagesSvc.listDataPackages = async () => ({
    items: [
      { hash: "abc123", groups: "tak_Old Ops,Shared" },
      { hash: "def456", groups: "Other Channel" },
    ],
  });
  dataPackagesSvc.updateDataPackageMetadata = async (hash, patch) => {
    packageWrites.push({ hash, groups: patch.groups.slice() });
    return { ok: true, groups: patch.groups };
  };
  channelPatchStore.list = () => [
    {
      id: "p1",
      enabled: true,
      mode: "bidirectional",
      groups: ["tak_Old Ops", "Keep Me"],
      dataSyncApplied: {
        "Ops Mission": { original: ["Old Ops"], added: ["Keep Me"] },
      },
    },
  ];
  channelPatchStore.update = (id, fields) => {
    patchUpdates.push({ id, fields });
    return { id, ...fields };
  };
  mutualAidStore.load = () => [
    {
      id: "ma-existing",
      groupMode: "existing",
      groupWasCreated: false,
      groupId: "g1",
      groupName: "tak_Old Ops",
      userId: "u1",
      title: "Linked User",
    },
    {
      id: "ma-other",
      groupMode: "existing",
      groupWasCreated: false,
      groupId: "g2",
      groupName: "tak_Other Channel",
      userId: "u2",
      title: "Other",
    },
    {
      id: "ma-sub",
      groupMode: "existing",
      groupWasCreated: false,
      groupId: "g1",
      groupName: "Old Ops",
      userId: "u3",
      type: "SUB-EVENT",
      title: "Sub User",
    },
  ];
  mutualAidStore.save = (items) => {
    mutualAidSaved = items;
  };
  usersSvc.getUserById = async (id) => ({
    id,
    attributes: { mutual_aid: true, mutual_aid_group: "tak_Old Ops" },
  });
  usersSvc.enqueueLocalUserAttributePatch = async (user, attrs) => {
    userAttrPatches.push({ userId: user.id, attrs });
  };

  try {
    const result = await propagate.propagateGroupRename("Old Ops", "Renamed Ops");
    assert.strictEqual(result.missions.updated, 1);
    assert.strictEqual(result.packages.updated, 1);
    assert.strictEqual(result.channelPatches.updated, 1);
    assert.strictEqual(result.mutualAid.updated, 2, "existing + sub linked to renamed channel");
    assert.deepStrictEqual(missionWrites[0].groups.sort(), ["Keep Me", "Renamed Ops"]);
    assert.deepStrictEqual(packageWrites[0].groups.sort(), ["Renamed Ops", "Shared"]);
    assert.deepStrictEqual(
      patchUpdates[0].fields.groups.sort(),
      ["Keep Me", "Renamed Ops"]
    );
    assert.deepStrictEqual(
      patchUpdates[0].fields.dataSyncApplied["Ops Mission"].original,
      ["Renamed Ops"]
    );
    const renamedMa = mutualAidSaved.filter((x) => x.groupId === "g1");
    assert.strictEqual(renamedMa.length, 2);
    assert.strictEqual(renamedMa[0].groupName, "tak_Renamed Ops");
    assert.strictEqual(renamedMa[1].groupName, "Renamed Ops");
    assert.ok(mutualAidSaved.some((x) => x.id === "ma-other" && x.groupName === "tak_Other Channel"));
    assert.ok(userAttrPatches.length >= 2);
    assert.ok(
      userAttrPatches.every((p) =>
        String(p.attrs.mutual_aid_group || "").toLowerCase().includes("renamed ops")
      )
    );
  } finally {
    dataSyncSvc.listMissions = orig.listMissions;
    dataSyncSvc.changeMission = orig.changeMission;
    dataPackagesSvc.listDataPackages = orig.listPackages;
    dataPackagesSvc.updateDataPackageMetadata = orig.updateMeta;
    channelPatchStore.list = orig.listPatches;
    channelPatchStore.update = orig.updatePatch;
    mutualAidStore.load = orig.maLoad;
    mutualAidStore.save = orig.maSave;
    usersSvc.getUserById = orig.getUser;
    usersSvc.enqueueLocalUserAttributePatch = orig.enqueueAttrs;
    if (prevTakUrl == null) delete process.env.TAK_URL;
    else process.env.TAK_URL = prevTakUrl;
    if (prevBypass == null) delete process.env.TAK_BYPASS_ENABLED;
    else process.env.TAK_BYPASS_ENABLED = prevBypass;
  }

  console.log("groupRenamePropagate.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
