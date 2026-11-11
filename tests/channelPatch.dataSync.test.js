"use strict";

const assert = require("assert");
const channelPatchDataSync = require("../services/channelPatchDataSync.service");
const channelPatchStore = require("../services/channelPatch.store");

(function testPlanAdditionsTracksOriginal() {
  const patch = {
    id: "p1",
    enabled: true,
    mode: "bidirectional",
    groups: ["tak_Alpha Ops", "Beta Tac", "Gamma Main"],
  };
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops"],
    tool: "public",
    description: "",
    defaultRole: { type: "MISSION_SUBSCRIBER" },
    keywords: [],
  };
  const plan = channelPatchDataSync.planAdditionsForMission(mission, patch);
  assert.deepStrictEqual(plan.original, ["Alpha Ops"]);
  assert.deepStrictEqual(plan.add.sort(), ["Beta Tac", "Gamma Main"]);
  assert.deepStrictEqual(plan.nextGroups.sort(), ["Alpha Ops", "Beta Tac", "Gamma Main"]);

  const already = channelPatchDataSync.planAdditionsForMission(
    { ...mission, groups: ["Alpha Ops", "Beta Tac", "Gamma Main"] },
    patch
  );
  assert.deepStrictEqual(already.add, []);
  assert.strictEqual(already.nextGroups.length, 3);

  const unrelated = channelPatchDataSync.planAdditionsForMission(
    { ...mission, groups: ["Other Channel"] },
    patch
  );
  assert.deepStrictEqual(unrelated.add, []);
})();

(function testPlanRestoreUsesOriginalAndOtherPatches() {
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops", "Beta Tac", "Gamma Main"],
  };
  const otherEnabled = [
    {
      id: "p2",
      enabled: true,
      mode: "bidirectional",
      groups: ["Alpha Ops", "Gamma Main"],
    },
  ];
  const plan = channelPatchDataSync.planRestoreForMission(
    mission,
    { original: ["Alpha Ops"], added: ["Beta Tac", "Gamma Main"] },
    otherEnabled
  );
  assert.deepStrictEqual(plan.original, ["Alpha Ops"]);
  assert.ok(plan.removed.includes("Beta Tac"));
  assert.ok(!plan.nextGroups.includes("Beta Tac"));
  assert.deepStrictEqual(plan.nextGroups.sort(), ["Alpha Ops", "Gamma Main"]);
})();

(function testPlanRestoreWithoutOtherPatches() {
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops", "Beta Tac"],
  };
  const plan = channelPatchDataSync.planRestoreForMission(
    mission,
    { original: ["Alpha Ops"], added: ["Beta Tac"] },
    []
  );
  assert.deepStrictEqual(plan.nextGroups, ["Alpha Ops"]);
  assert.deepStrictEqual(plan.removed, ["Beta Tac"]);
})();

(function testLockedGroupsFromAppliedLedger() {
  const patches = [
    {
      id: "p1",
      enabled: true,
      mode: "bidirectional",
      groups: ["Alpha Ops", "Beta Tac"],
      dataSyncApplied: {
        "Ops Mission": { original: ["Alpha Ops"], added: ["Beta Tac"] },
      },
    },
    {
      id: "p2",
      enabled: false,
      mode: "bidirectional",
      groups: ["Alpha Ops", "Gamma Main"],
      dataSyncApplied: {
        "Ops Mission": { original: ["Alpha Ops"], added: ["Gamma Main"] },
      },
    },
  ];
  assert.deepStrictEqual(
    channelPatchDataSync.lockedGroupsForMission("Ops Mission", patches),
    ["Alpha Ops", "Beta Tac"],
    "all patch channels lock, including originals"
  );
  assert.deepStrictEqual(
    channelPatchDataSync.addedGroupsForMission("Ops Mission", patches),
    ["Beta Tac"]
  );
  const annotated = channelPatchDataSync.annotateMissionsWithPatchPeers(
    [{ name: "Ops Mission", groups: ["Alpha Ops", "Beta Tac"] }],
    patches
  );
  assert.deepStrictEqual(annotated[0].patchLockedGroups, ["Alpha Ops", "Beta Tac"]);
  assert.deepStrictEqual(annotated[0].patchedWith, ["Beta Tac"]);
})();

(function testAffectedDataSyncNames() {
  assert.deepStrictEqual(
    channelPatchDataSync.affectedDataSyncNames({
      dataSyncApplied: {
        "Mission B": { original: ["A"], added: ["B"] },
        "Mission A": { original: ["A"], added: ["C"] },
      },
    }),
    ["Mission A", "Mission B"]
  );
})();

(function testPatchedWithLabels() {
  const patches = [
    {
      id: "p1",
      enabled: true,
      mode: "bidirectional",
      groups: ["tak_Alpha Ops", "Beta Tac"],
    },
  ];
  const labels = channelPatchDataSync.patchedWithLabelsForMission(
    { groups: ["Alpha Ops"] },
    patches
  );
  assert.deepStrictEqual(labels, ["Beta Tac"]);

  const annotated = channelPatchDataSync.annotateMissionsWithPatchPeers(
    [
      { name: "Ops Mission", groups: ["Alpha Ops"] },
      { name: "Solo", groups: ["Other Channel"] },
    ],
    patches
  );
  assert.deepStrictEqual(annotated[0].patchedWith, ["Beta Tac"]);
  assert.strictEqual(annotated[1].patchedWith, undefined);
})();

(function testNormalizePersistsDataSyncAppliedObject() {
  const patch = channelPatchStore.normalizePatch({
    id: "p-applied",
    name: "Applied",
    enabled: true,
    mode: "bidirectional",
    groups: ["Alpha Ops", "Beta Tac"],
    dataSyncApplied: {
      "Ops Mission": {
        original: ["tak_Alpha Ops"],
        added: ["tak_Beta Tac", "Beta Tac"],
      },
    },
  });
  assert.ok(patch);
  assert.deepStrictEqual(patch.dataSyncApplied["Ops Mission"].original, ["Alpha Ops"]);
  assert.deepStrictEqual(patch.dataSyncApplied["Ops Mission"].added, ["Beta Tac"]);
})();

(function testNormalizeLegacyAppliedArray() {
  const patch = channelPatchStore.normalizePatch({
    id: "p-legacy",
    name: "Legacy",
    enabled: true,
    mode: "bidirectional",
    groups: ["Alpha Ops", "Beta Tac"],
    dataSyncApplied: {
      "Ops Mission": ["Beta Tac"],
    },
  });
  assert.deepStrictEqual(patch.dataSyncApplied["Ops Mission"].added, ["Beta Tac"]);
  assert.deepStrictEqual(patch.dataSyncApplied["Ops Mission"].original, []);
})();

(function testBuildMissionWriteBody() {
  const body = channelPatchDataSync.buildMissionWriteBody(
    {
      name: "Ops Mission",
      tool: "public",
      description: "desc",
      defaultRole: { type: "MISSION_OWNER" },
      keywords: ["datasync"],
      inviteOnly: false,
    },
    ["tak_Alpha Ops", "Beta Tac", "Alpha Ops"]
  );
  assert.strictEqual(body.name, "Ops Mission");
  assert.deepStrictEqual(body.groups, ["Alpha Ops", "Beta Tac"]);
  assert.strictEqual(body.defaultRole.type, "MISSION_OWNER");
  assert.deepStrictEqual(body.keywords, ["datasync"]);
})();

(async function testDisableUnappliesAndReenableReapplies() {
  const prevTakUrl = process.env.TAK_URL;
  const prevBypass = process.env.TAK_BYPASS_ENABLED;
  process.env.TAK_URL = process.env.TAK_URL || "https://tak.test.example";
  delete process.env.TAK_BYPASS_ENABLED;

  const dataSyncSvc = require("../services/dataSync.service");
  const store = require("../services/channelPatch.store");

  let missionGroups = ["Alpha Ops"];
  let persistedApplied = {};
  const orig = {
    list: dataSyncSvc.listMissions,
    get: dataSyncSvc.getMission,
    change: dataSyncSvc.changeMission,
    listEnabled: store.listEnabled,
    update: store.update,
  };

  function missionPayload() {
    return {
      name: "Ops Mission",
      groups: missionGroups.slice(),
      tool: "public",
      description: "",
      defaultRole: { type: "MISSION_SUBSCRIBER" },
      keywords: [],
    };
  }

  dataSyncSvc.listMissions = async () => ({ data: [missionPayload()] });
  dataSyncSvc.getMission = async () => missionPayload();
  dataSyncSvc.changeMission = async (_name, body) => {
    missionGroups = Array.isArray(body.groups) ? body.groups.slice() : [];
    return {};
  };
  store.listEnabled = () => [];
  store.update = (id, fields) => {
    if (fields && Object.prototype.hasOwnProperty.call(fields, "dataSyncApplied")) {
      persistedApplied = fields.dataSyncApplied || {};
    }
    return { id, ...(fields || {}) };
  };

  try {
    const patchBase = {
      id: "p-toggle",
      name: "Toggle Patch",
      enabled: true,
      mode: "bidirectional",
      groups: ["Alpha Ops", "Beta Tac"],
      dataSyncApplied: {},
    };

    await channelPatchDataSync.syncDataSyncsForPatchChange({
      before: null,
      after: patchBase,
    });
    assert.deepStrictEqual(
      missionGroups.slice().sort(),
      ["Alpha Ops", "Beta Tac"],
      "enable adds patched channels"
    );
    assert.ok(persistedApplied["Ops Mission"], "ledger recorded");
    assert.deepStrictEqual(persistedApplied["Ops Mission"].original, ["Alpha Ops"]);
    assert.deepStrictEqual(persistedApplied["Ops Mission"].added, ["Beta Tac"]);

    const enabledWithLedger = {
      ...patchBase,
      dataSyncApplied: persistedApplied,
    };
    await channelPatchDataSync.syncDataSyncsForPatchChange({
      before: enabledWithLedger,
      after: { ...enabledWithLedger, enabled: false },
    });
    assert.deepStrictEqual(
      missionGroups,
      ["Alpha Ops"],
      "disable restores original channels"
    );
    assert.ok(
      persistedApplied["Ops Mission"],
      "ledger kept while disabled for re-enable"
    );

    await channelPatchDataSync.syncDataSyncsForPatchChange({
      before: { ...enabledWithLedger, enabled: false },
      after: { ...enabledWithLedger, enabled: true },
    });
    assert.deepStrictEqual(
      missionGroups.slice().sort(),
      ["Alpha Ops", "Beta Tac"],
      "re-enable adds patched channels back"
    );
  } finally {
    dataSyncSvc.listMissions = orig.list;
    dataSyncSvc.getMission = orig.get;
    dataSyncSvc.changeMission = orig.change;
    store.listEnabled = orig.listEnabled;
    store.update = orig.update;
    if (prevTakUrl == null) delete process.env.TAK_URL;
    else process.env.TAK_URL = prevTakUrl;
    if (prevBypass == null) delete process.env.TAK_BYPASS_ENABLED;
    else process.env.TAK_BYPASS_ENABLED = prevBypass;
  }

  console.log("channelPatch.dataSync.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
